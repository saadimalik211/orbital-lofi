"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  loadAudioBuffer,
  preloadWorldAmbience,
  startAmbienceVoice,
  stopAmbienceVoices,
  type AmbienceVoice,
} from "@/audio/ambienceEngine";
import {
  ambienceLevel,
  clampVolume,
  getAmbiencePrefs,
  getServerAmbiencePrefs,
  subscribeAmbiencePrefs,
  updateAmbiencePrefs,
} from "@/audio/ambiencePrefs";
import { compose, describeComposition, type Composition } from "@/audio/music/composer";
import { createMusicEngine, type MusicEngine } from "@/audio/music/musicEngine";
import { randomSeed } from "@/audio/music/random";
import type { World, WorldId } from "@/worlds/types";

export type AudioEngineStatus = "idle" | "live" | "error";

const DEFAULT_VOLUME = 0.55;
const TRANSITION_FADE_S = 0.55;
const NEXT_FADE_OUT_S = 0.6;
const NEXT_FADE_IN_S = 0.9;
const isDev = process.env.NODE_ENV !== "production";

type MusicDevHandle = {
  current: () => string | null;
  next: () => void;
};

declare global {
  interface Window {
    orbitalMusic?: MusicDevHandle;
  }
}

/**
 * procedural music → music (Next fades) ┐
 *        ambience / event sounds        ┴→ master (user volume) → output (transition fade) → speakers
 */
type AudioGraph = {
  context: AudioContext;
  master: GainNode;
  output: GainNode;
  music: GainNode;
  ambience: GainNode;
  engine: MusicEngine;
};

type Sounding = { worldId: WorldId; composition: Composition };

function createGraph(volume: number): AudioGraph {
  const context = new AudioContext();
  const gain = (value: number) => {
    const node = context.createGain();
    node.gain.value = value;
    return node;
  };
  const master = gain(volume);
  const output = gain(1);
  const music = gain(1);
  const ambience = gain(1);
  music.connect(master);
  ambience.connect(master);
  master.connect(output);
  output.connect(context.destination);
  return { context, master, output, music, ambience, engine: createMusicEngine(context, music) };
}

function fadeTo(gain: GainNode, value: number, seconds = 0.85) {
  const now = gain.context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(value, now + seconds);
}

function composeFor(world: World, previousSeed?: number) {
  const composition = compose(world.music, randomSeed(previousSeed));
  if (isDev) {
    console.info(`[orbital-lofi] music ${world.id}: ${describeComposition(composition)}`);
  }
  return composition;
}

export function useAudioEngine(initialWorld: World) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  const [status, setStatus] = useState<AudioEngineStatus>("idle");
  const ambiencePrefs = useSyncExternalStore(
    subscribeAmbiencePrefs,
    getAmbiencePrefs,
    getServerAmbiencePrefs,
  );

  const graphRef = useRef<AudioGraph | null>(null);
  const voicesRef = useRef(new Map<string, AmbienceVoice>());
  const eventSoundRef = useRef<{ stop: () => void } | null>(null);

  /** The world audio should follow: the transition target, set before the screen swaps. */
  const worldRef = useRef(initialWorld);
  /** Composition queued for `worldRef`; created lazily, replaced by Next and world changes. */
  const compositionRef = useRef<Composition | null>(null);
  /** What the music engine is actually playing, or null when stopped. */
  const soundingRef = useRef<Sounding | null>(null);
  const nextTimerRef = useRef(0);
  const playingRef = useRef(false);
  const startingRef = useRef(false);
  const volumeRef = useRef(DEFAULT_VOLUME);
  const restoreVolumeRef = useRef(DEFAULT_VOLUME);

  // Bumping a token invalidates in-flight async work of that kind.
  const startTokenRef = useRef(0);
  const ambienceTokenRef = useRef(0);
  const eventTokenRef = useRef(0);

  const ensureGraph = useCallback(async () => {
    const graph = (graphRef.current ??= createGraph(volumeRef.current));
    // Called synchronously inside the click/keypress so autoplay policy allows it.
    const resumed = graph.context.resume().catch(() => {});
    if (graph.context.state !== "running") {
      await resumed;
    }
    return graph;
  }, []);

  const queuedComposition = useCallback(() => {
    compositionRef.current ??= composeFor(worldRef.current);
    return compositionRef.current;
  }, []);

  const clearNextTimer = useCallback(() => {
    window.clearTimeout(nextTimerRef.current);
    nextTimerRef.current = 0;
  }, []);

  const applyAmbienceLevel = useCallback((trackId: string) => {
    const voice = voicesRef.current.get(trackId);
    if (!voice) {
      return;
    }
    const now = voice.gain.context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(ambienceLevel(voice.track, getAmbiencePrefs()), now, 0.03);
  }, []);

  const stopAmbience = useCallback(() => {
    ambienceTokenRef.current += 1;
    stopAmbienceVoices(voicesRef.current);
  }, []);

  const startAmbience = useCallback(
    async (world: World) => {
      stopAmbience();
      const token = ambienceTokenRef.current;
      const graph = graphRef.current;
      if (!graph || !playingRef.current) {
        return;
      }

      // Each track loads independently; a missing file only silences that track.
      const loaded = await Promise.all(
        world.ambience.map((track) =>
          loadAudioBuffer(graph.context, track.src).then(
            (buffer) => ({ track, buffer }),
            () => null,
          ),
        ),
      );
      if (token !== ambienceTokenRef.current || !playingRef.current) {
        return;
      }

      const prefs = getAmbiencePrefs();
      for (const item of loaded) {
        if (item) {
          voicesRef.current.set(
            item.track.id,
            startAmbienceVoice(
              graph.context,
              graph.ambience,
              item.track,
              item.buffer,
              ambienceLevel(item.track, prefs),
            ),
          );
        }
      }
    },
    [stopAmbience],
  );

  /** Replaces whatever is playing with `composition`, ramping the music stage back up. */
  const startMusic = useCallback(
    (worldId: WorldId, composition: Composition, fadeInSeconds: number, fromStep = 0) => {
      const graph = graphRef.current;
      if (!graph) {
        return;
      }
      clearNextTimer();
      graph.engine.play(composition, fromStep);
      soundingRef.current = { worldId, composition };
      fadeTo(graph.music, 1, fadeInSeconds);
    },
    [clearNextTimer],
  );

  const startWorldAudio = useCallback(
    (world: World) => {
      const sameWorld = soundingRef.current?.worldId === world.id;
      startMusic(world.id, queuedComposition(), 0.05);
      if (!sameWorld) {
        void startAmbience(world);
      }
      setStatus("live");
    },
    [queuedComposition, startAmbience, startMusic],
  );

  const nextComposition = useCallback(() => {
    const world = worldRef.current;
    compositionRef.current = composeFor(world, compositionRef.current?.seed);

    // Paused, starting, or mid world-transition: only the queued composition changes.
    const graph = graphRef.current;
    if (!graph || !playingRef.current || soundingRef.current?.worldId !== world.id) {
      return;
    }
    // A fade-out already in flight plays the latest composition when it lands.
    if (nextTimerRef.current) {
      return;
    }
    fadeTo(graph.music, 0, NEXT_FADE_OUT_S);
    nextTimerRef.current = window.setTimeout(() => {
      nextTimerRef.current = 0;
      const current = worldRef.current;
      const queued = compositionRef.current;
      if (playingRef.current && queued && soundingRef.current?.worldId === current.id) {
        // Manual Next can skip the intro; Play and world changes still begin at step 0.
        const fromStep =
          current.music.nextStartMode === "main"
            ? (queued.sections.find((section) => section.kind === "a")?.step ?? 0)
            : 0;
        startMusic(current.id, queued, NEXT_FADE_IN_S, fromStep);
      }
    }, NEXT_FADE_OUT_S * 1000);
  }, [startMusic]);

  const stopEventSound = useCallback(() => {
    eventTokenRef.current += 1;
    eventSoundRef.current?.stop();
    eventSoundRef.current = null;
  }, []);

  const playEventSound = useCallback(
    async (src: string, level = 0.5) => {
      const graph = graphRef.current;
      if (!playingRef.current || !graph) {
        return false;
      }

      stopEventSound();
      const token = eventTokenRef.current;
      let buffer: AudioBuffer;
      try {
        buffer = await loadAudioBuffer(graph.context, src);
      } catch {
        return false;
      }
      if (token !== eventTokenRef.current || !playingRef.current || graphRef.current !== graph) {
        return false;
      }

      const { context } = graph;
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = clampVolume(level);
      source.connect(gain);
      gain.connect(graph.master);

      const handle = {
        stop() {
          source.onended = null;
          const t = context.currentTime;
          gain.gain.cancelScheduledValues(t);
          gain.gain.setValueAtTime(gain.gain.value, t);
          gain.gain.linearRampToValueAtTime(0, t + 0.08);
          try {
            source.stop(t + 0.1);
          } catch {
            // already stopped
          }
          window.setTimeout(() => {
            source.disconnect();
            gain.disconnect();
          }, 150);
          if (eventSoundRef.current === handle) {
            eventSoundRef.current = null;
          }
        },
      };
      source.onended = () => handle.stop();
      eventSoundRef.current = handle;
      source.start();
      return true;
    },
    [stopEventSound],
  );

  const stopPlayback = useCallback(() => {
    startTokenRef.current += 1;
    startingRef.current = false;
    playingRef.current = false;
    soundingRef.current = null;
    setIsPlaying(false);
    clearNextTimer();
    stopAmbience();
    stopEventSound();
    const graph = graphRef.current;
    if (graph) {
      graph.engine.stop();
      for (const stage of [graph.output, graph.music]) {
        stage.gain.cancelScheduledValues(graph.context.currentTime);
        stage.gain.value = 1;
      }
    }
    setStatus("idle");
  }, [clearNextTimer, stopAmbience, stopEventSound]);

  const togglePlayback = useCallback(async () => {
    // A second press while the context is still resuming cancels the start.
    if (playingRef.current || startingRef.current) {
      stopPlayback();
      return;
    }

    const token = (startTokenRef.current += 1);
    startingRef.current = true;
    try {
      const graph = await ensureGraph();
      if (token !== startTokenRef.current) {
        return;
      }
      startingRef.current = false;
      if (graph.context.state !== "running") {
        if (isDev) {
          console.warn("[orbital-lofi] Audio is blocked by the browser; press Play again");
        }
        setStatus("idle");
        return;
      }
      playingRef.current = true;
      setIsPlaying(true);
      startWorldAudio(worldRef.current);
    } catch (error) {
      if (token !== startTokenRef.current) {
        return;
      }
      startingRef.current = false;
      console.error("[orbital-lofi] Playback failed", error);
      setStatus("error");
    }
  }, [ensureGraph, startWorldAudio, stopPlayback]);

  const beginWorldTransition = useCallback(
    (world: World) => {
      worldRef.current = world;
      // Every world visit gets a fresh composition from that world's profile.
      compositionRef.current = composeFor(world, compositionRef.current?.seed);
      // A pending Next is abandoned; finishWorldTransition starts the new composition.
      clearNextTimer();
      stopEventSound();
      const graph = graphRef.current;
      if (!graph) {
        return;
      }
      preloadWorldAmbience(graph.context, world);
      if (playingRef.current) {
        fadeTo(graph.output, 0, TRANSITION_FADE_S);
      }
    },
    [clearNextTimer, stopEventSound],
  );

  const finishWorldTransition = useCallback(
    (world: World) => {
      worldRef.current = world;
      const graph = graphRef.current;
      if (!playingRef.current) {
        if (graph) {
          fadeTo(graph.output, 1, 0.05);
        }
        return;
      }
      // Swapped under the cover while output is faded out, so the restart is inaudible.
      startWorldAudio(world);
      if (graph) {
        fadeTo(graph.output, 1, TRANSITION_FADE_S);
      }
    },
    [startWorldAudio],
  );

  const setVolume = useCallback((next: number) => {
    const clamped = clampVolume(next);
    volumeRef.current = clamped;
    setVolumeState(clamped);
    const graph = graphRef.current;
    if (graph) {
      graph.master.gain.setTargetAtTime(clamped, graph.context.currentTime, 0.02);
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (volumeRef.current > 0) {
      restoreVolumeRef.current = volumeRef.current;
      setVolume(0);
    } else {
      setVolume(restoreVolumeRef.current);
    }
  }, [setVolume]);

  const setAmbienceVolume = useCallback(
    (trackId: string, next: number) => {
      updateAmbiencePrefs((prefs) => ({
        volumes: { ...prefs.volumes, [trackId]: clampVolume(next) },
        muted: { ...prefs.muted, [trackId]: false },
      }));
      applyAmbienceLevel(trackId);
    },
    [applyAmbienceLevel],
  );

  const toggleAmbienceMute = useCallback(
    (trackId: string) => {
      updateAmbiencePrefs((prefs) => ({
        ...prefs,
        muted: { ...prefs.muted, [trackId]: !prefs.muted[trackId] },
      }));
      applyAmbienceLevel(trackId);
    },
    [applyAmbienceLevel],
  );

  useEffect(() => {
    if (!isDev) {
      return;
    }
    const handle: MusicDevHandle = {
      current: () => {
        const composition = soundingRef.current?.composition ?? compositionRef.current;
        return composition ? describeComposition(composition) : null;
      },
      next: nextComposition,
    };
    window.orbitalMusic = handle;
    return () => {
      if (window.orbitalMusic === handle) {
        delete window.orbitalMusic;
      }
    };
  }, [nextComposition]);

  useEffect(() => {
    const voices = voicesRef.current;
    return () => {
      startTokenRef.current += 1;
      ambienceTokenRef.current += 1;
      startingRef.current = false;
      playingRef.current = false;
      soundingRef.current = null;
      window.clearTimeout(nextTimerRef.current);
      nextTimerRef.current = 0;
      stopAmbienceVoices(voices);
      stopEventSound();
      const graph = graphRef.current;
      graphRef.current = null;
      graph?.engine.dispose();
      void graph?.context.close().catch(() => {});
      setIsPlaying(false);
      setStatus("idle");
    };
  }, [stopEventSound]);

  return {
    isPlaying,
    volume,
    status,
    ambiencePrefs,
    togglePlayback,
    nextComposition,
    beginWorldTransition,
    finishWorldTransition,
    setVolume,
    toggleMute,
    setAmbienceVolume,
    toggleAmbienceMute,
    playEventSound,
    stopEventSound,
  };
}
