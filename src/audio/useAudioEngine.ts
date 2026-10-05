"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { readClip, writeClip } from "@/audio/clipCache";
import {
  pcmToAudioBuffer,
  startLoopingBuffer,
  type LoopHandle,
} from "@/audio/loopBuffer";
import {
  generateMusicClip,
  warmupMusicgen,
  type GeneratedClip,
} from "@/audio/musicgenClient";
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
import {
  createProceduralEngine,
  type ProceduralEngine,
} from "@/audio/proceduralEngine";
import type { World, WorldId } from "@/worlds/types";

export type AudioEngineStatus =
  | "idle"
  | "loading-model"
  | "generating"
  | "bed"
  | "ready"
  | "error";

const DEFAULT_VOLUME = 0.55;
const TRANSITION_FADE_S = 0.55;
const isDev = process.env.NODE_ENV !== "production";

/**
 * bed / clip / ambience / event sounds → master (user volume) → output (transition fade) → speakers
 */
type AudioGraph = {
  context: AudioContext;
  master: GainNode;
  output: GainNode;
  bed: GainNode;
  clip: GainNode;
  ambience: GainNode;
};

function createGraph(volume: number): AudioGraph {
  const context = new AudioContext();
  const gain = (value: number) => {
    const node = context.createGain();
    node.gain.value = value;
    return node;
  };
  const graph = {
    context,
    master: gain(volume),
    output: gain(1),
    bed: gain(1),
    clip: gain(0),
    ambience: gain(1),
  };
  graph.bed.connect(graph.master);
  graph.clip.connect(graph.master);
  graph.ambience.connect(graph.master);
  graph.master.connect(graph.output);
  graph.output.connect(context.destination);
  return graph;
}

function fadeTo(gain: GainNode, value: number, seconds = 0.85) {
  const now = gain.context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(value, now + seconds);
}

function clipCacheKey(world: World) {
  return `${world.id}:${world.music.prompt}`;
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
  const bootRef = useRef<Promise<ProceduralEngine> | null>(null);
  const engineRef = useRef<ProceduralEngine | null>(null);
  const loopRef = useRef<LoopHandle | null>(null);
  const voicesRef = useRef(new Map<string, AmbienceVoice>());
  const eventSoundRef = useRef<{ stop: () => void } | null>(null);

  /** The world audio should follow: the transition target, set before the screen swaps. */
  const worldRef = useRef(initialWorld);
  /** The world whose sources are currently running, or null when stopped. */
  const soundingWorldIdRef = useRef<WorldId | null>(null);
  const playingRef = useRef(false);
  const startingRef = useRef(false);
  const volumeRef = useRef(DEFAULT_VOLUME);
  const restoreVolumeRef = useRef(DEFAULT_VOLUME);

  // Bumping a token invalidates in-flight async work of that kind.
  const startTokenRef = useRef(0);
  const clipTokenRef = useRef(0);
  const ambienceTokenRef = useRef(0);
  const eventTokenRef = useRef(0);

  const ensureGraph = useCallback(async () => {
    const graph = (graphRef.current ??= createGraph(volumeRef.current));
    // Called synchronously inside the click/keypress so autoplay policy allows it.
    void graph.context.resume().catch(() => {});

    bootRef.current ??= createProceduralEngine(graph.context, graph.bed).then(
      (engine) => {
        if (graphRef.current === graph) {
          engineRef.current = engine;
        }
        return engine;
      },
      (error: unknown) => {
        bootRef.current = null;
        throw error;
      },
    );

    await bootRef.current;
    if (graph.context.state === "suspended") {
      await graph.context.resume();
    }
    return graph;
  }, []);

  const stopClip = useCallback(() => {
    loopRef.current?.stop(0.05);
    loopRef.current = null;
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

  const playClip = useCallback(
    (clip: GeneratedClip) => {
      const graph = graphRef.current;
      if (!graph || clip.samples.length < 1024) {
        return;
      }
      const buffer = pcmToAudioBuffer(graph.context, clip.samples, clip.sampleRate);
      stopClip();
      fadeTo(graph.bed, 0);
      fadeTo(graph.clip, 1);
      loopRef.current = startLoopingBuffer(graph.context, graph.clip, buffer);
      engineRef.current?.stop();
      setStatus("ready");
    },
    [stopClip],
  );

  const requestNeuralClip = useCallback(
    async (world: World) => {
      const token = (clipTokenRef.current += 1);
      const isCurrent = () => token === clipTokenRef.current && playingRef.current;
      const key = clipCacheKey(world);

      const cached = await readClip(key);
      if (!isCurrent()) {
        return;
      }
      if (cached) {
        playClip(cached);
        return;
      }

      try {
        const clip = await generateMusicClip(world.music.prompt, (nextStatus) => {
          if (isCurrent()) {
            setStatus(nextStatus);
          }
        });
        await writeClip(key, clip);
        if (isCurrent()) {
          playClip(clip);
        }
      } catch (error) {
        if (isDev) {
          console.warn("[orbital-lofi] MusicGen clip unavailable; staying on bed", error);
        }
        if (isCurrent()) {
          setStatus("bed");
        }
      }
    },
    [playClip],
  );

  const startBed = useCallback(
    (world: World) => {
      const graph = graphRef.current;
      if (graph) {
        fadeTo(graph.clip, 0, 0.4);
        fadeTo(graph.bed, 1, 0.4);
      }
      stopClip();
      engineRef.current?.start(world.music.bed);
      setStatus("bed");
    },
    [stopClip],
  );

  const startWorldAudio = useCallback(
    (world: World) => {
      soundingWorldIdRef.current = world.id;
      startBed(world);
      void requestNeuralClip(world);
      void startAmbience(world);
    },
    [requestNeuralClip, startAmbience, startBed],
  );

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
    clipTokenRef.current += 1;
    startingRef.current = false;
    playingRef.current = false;
    soundingWorldIdRef.current = null;
    setIsPlaying(false);
    engineRef.current?.stop();
    stopClip();
    stopAmbience();
    stopEventSound();
    const graph = graphRef.current;
    if (graph) {
      fadeTo(graph.clip, 0, 0.05);
      graph.output.gain.cancelScheduledValues(graph.context.currentTime);
      graph.output.gain.value = 1;
    }
    setStatus("idle");
  }, [stopAmbience, stopClip, stopEventSound]);

  const togglePlayback = useCallback(async () => {
    // A second press while the engine is still booting cancels the start.
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
      if (soundingWorldIdRef.current !== world.id) {
        clipTokenRef.current += 1;
      }
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
    [stopEventSound],
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
      if (soundingWorldIdRef.current !== world.id) {
        startWorldAudio(world);
      }
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
    const warm = () => {
      void warmupMusicgen((nextStatus) => {
        if (!playingRef.current) {
          setStatus(nextStatus);
        }
      })
        .then(() => {
          if (!playingRef.current) {
            setStatus("idle");
          }
        })
        .catch(() => {});
    };

    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(warm, { timeout: 1200 });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = window.setTimeout(warm, 400);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const voices = voicesRef.current;
    return () => {
      startTokenRef.current += 1;
      clipTokenRef.current += 1;
      ambienceTokenRef.current += 1;
      startingRef.current = false;
      playingRef.current = false;
      soundingWorldIdRef.current = null;
      engineRef.current?.stop();
      loopRef.current?.stop(0.01);
      loopRef.current = null;
      stopAmbienceVoices(voices);
      stopEventSound();
      const graph = graphRef.current;
      graphRef.current = null;
      bootRef.current = null;
      engineRef.current = null;
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
