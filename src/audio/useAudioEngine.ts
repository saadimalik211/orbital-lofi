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
import { createAiLibrary, type AiLibrary, type MusicSource } from "@/audio/ai/aiMusic";
import { compose, describeComposition, type Composition } from "@/audio/music/composer";
import { describeSilence } from "@/audio/music/silence";
import { createMusicEngine, type MusicEngine, type SchedulerCatchup } from "@/audio/music/musicEngine";
import { type NowPlayingInfo } from "@/audio/music/nowPlaying";
import { randomSeed } from "@/audio/music/random";
import { isCurrentGeneration, nextBarHandoff, pieceSeconds, pieceTailSeconds } from "@/audio/music/renderMath";
import {
  offlineRenderSupported,
  renderProceduralPiece,
  startRenderedLoop,
  type LoopVoice,
} from "@/audio/music/renderPiece";
import type { World, WorldId } from "@/worlds/types";
import { getWorldById } from "@/worlds/worlds";

export type AudioEngineStatus = "idle" | "live" | "error";
export type { MusicSource };

const DEFAULT_VOLUME = 0.55;
const TRANSITION_FADE_S = 0.55;
const NEXT_FADE_OUT_S = 0.6;
const NEXT_FADE_IN_S = 0.9;
const isDev = process.env.NODE_ENV !== "production";

type MusicDevHandle = {
  current: () => string | null;
  /** Score silence for the current piece. Development only. */
  silence: () => string | null;
  /** Audible music source. Development only. */
  source: () => MusicSource;
  next: () => void;
  /** Compact playback snapshot. Development only. */
  audioDebug: () => string;
  /** Run one scheduler tick as if the timer woke this many seconds late. */
  simulateStall: (seconds: number) => SchedulerCatchup | null;
  /**
   * One suspend-then-resume of the existing context. Development only.
   * Does not create a new AudioContext.
   */
  outputKick: () => Promise<string>;
};

/** Safari adds `"interrupted"` for interruptions such as a phone call or a locked screen. */
type ContextState = AudioContextState | "interrupted";

function contextState(context: BaseAudioContext): ContextState {
  return context.state as ContextState;
}

function needsResume(state: ContextState) {
  return state === "suspended" || state === "interrupted";
}

function logAudio(event: string, detail?: Record<string, unknown>) {
  if (!isDev) {
    return;
  }
  if (detail) {
    console.info(`[orbital-lofi] audio ${event}`, detail);
    return;
  }
  console.info(`[orbital-lofi] audio ${event}`);
}

const RESUME_WAIT_MS = 1200;

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** `resume()` is started by the caller so a user gesture still counts. This only bounds the wait. */
async function finishResume(pending: Promise<unknown>, context: AudioContext) {
  await Promise.race([pending.catch(() => undefined), wait(RESUME_WAIT_MS)]);
  return contextState(context);
}

async function resumeContext(context: AudioContext) {
  return finishResume(context.resume(), context);
}

/** One-shot WebKit nudge when the context stays `"running"` but its clock has stopped. */
async function kickContext(context: AudioContext) {
  await Promise.race([context.suspend().catch(() => undefined), wait(500)]);
  await wait(80);
  return resumeContext(context);
}

declare global {
  interface Window {
    orbitalMusic?: MusicDevHandle;
  }
}

/**
 * procedural ─┐
 * ai file    ─┴→ music (Next fades) ┐
 *        ambience / event sounds    ┴→ master (user volume) → output (transition fade) → speakers
 */
type AudioGraph = {
  context: AudioContext;
  master: GainNode;
  output: GainNode;
  music: GainNode;
  ambience: GainNode;
  /** Live notes and the rendered buffer both enter here, under the music fade. */
  procedural: GainNode;
  engine: MusicEngine;
  ai: AiLibrary;
};

type ProceduralRenderState = "idle" | "rendering" | "ready" | "active" | "failed";

type RenderHold = {
  generation: number;
  state: ProceduralRenderState;
  worldId: WorldId | null;
  seed: number | null;
  buffer: AudioBuffer | null;
  voice: LoopVoice | null;
  handoffAt: number | null;
  pausedOffset: number | null;
  pieceSeconds: number | null;
  tailSeconds: number | null;
  renderMs: number | null;
  scheduledEvents: number | null;
  sampleRate: number | null;
  channels: number | null;
  bytes: number | null;
};

type RenderRequest = { generation: number; composition: Composition };

const emptyRender = (generation: number): RenderHold => ({
  generation,
  state: "idle",
  worldId: null,
  seed: null,
  buffer: null,
  voice: null,
  handoffAt: null,
  pausedOffset: null,
  pieceSeconds: null,
  tailSeconds: null,
  renderMs: null,
  scheduledEvents: null,
  sampleRate: null,
  channels: null,
  bytes: null,
});

type Sounding = { worldId: WorldId; composition: Composition };

/** The lookahead timer stays down once the rendered buffer has taken the voice. */
function liveSchedulerWanted(graph: AudioGraph, job: RenderHold) {
  if (job.pausedOffset != null) {
    return false;
  }
  if (job.voice && job.handoffAt != null && graph.context.currentTime >= job.handoffAt - 0.03) {
    return false;
  }
  return true;
}

function describeRender(graph: AudioGraph | null, job: RenderHold) {
  const now = graph ? graph.context.currentTime : null;
  const handed =
    job.voice != null && job.handoffAt != null && now != null && now >= job.handoffAt - 0.001;
  const state = job.state === "ready" && handed ? "active" : job.state;
  const offset =
    job.voice && now != null ? job.voice.offsetAt(now) : job.pausedOffset;
  const memory =
    job.bytes == null ? "n/a" : `~${Math.max(1, Math.round(job.bytes / (1024 * 1024)))} MB`;
  const seconds = (value: number | null) => (value == null ? "n/a" : `${value.toFixed(1)} s`);
  return [
    `Procedural mode: ${state === "active" ? "rendered" : "live"}`,
    `Render state: ${state}`,
    `Render generation: ${job.generation}`,
    `Seed: ${job.seed ?? "n/a"}`,
    `Piece duration: ${seconds(job.pieceSeconds)}`,
    `Tail: ${seconds(job.tailSeconds)}`,
    `Rendered buffer: ${job.buffer ? seconds(job.buffer.duration) : "n/a"}`,
    `Render sample rate: ${job.sampleRate ?? "n/a"}`,
    `Render channels: ${job.channels ?? "n/a"}`,
    `Render time: ${job.renderMs == null ? "n/a" : `${(job.renderMs / 1000).toFixed(1)} s`}`,
    `Scheduled events: ${job.scheduledEvents ?? "n/a"}`,
    `Buffer memory: ${memory}`,
    `Live scheduler: ${graph?.engine.health().active ? "active" : "stopped"}`,
    `Rendered source: ${job.voice ? (handed ? "active" : "scheduled") : job.pausedOffset != null ? "paused" : "none"}`,
    `Playback offset: ${seconds(offset)}`,
    `Looping: ${job.voice || job.pausedOffset != null ? "yes" : "no"}`,
  ];
}

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
  const procedural = gain(1);
  const aiBus = gain(0);
  procedural.connect(music);
  aiBus.connect(music);
  music.connect(master);
  ambience.connect(master);
  master.connect(output);
  output.connect(context.destination);
  return {
    context,
    master,
    output,
    music,
    ambience,
    procedural,
    engine: createMusicEngine(context, procedural),
    ai: createAiLibrary(context, procedural, aiBus, (message) => {
      if (isDev) {
        console.info(`[orbital-lofi] ${message}`);
      }
    }),
  };
}

type PendingFade = { param: AudioParam; target: number; endWall: number };

function rememberFade(ledger: PendingFade[], param: AudioParam, target: number, endWall: number) {
  const mark = { param, target, endWall };
  const index = ledger.findIndex((fade) => fade.param === param);
  if (index >= 0) {
    ledger[index] = mark;
  } else {
    ledger.push(mark);
  }
}

function fadeTo(ledger: PendingFade[], gain: GainNode, value: number, seconds = 0.85) {
  const now = gain.context.currentTime;
  const duration = Math.max(0, seconds);
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  if (duration <= 0) {
    gain.gain.setValueAtTime(value, now);
  } else {
    gain.gain.linearRampToValueAtTime(value, now + duration);
  }
  rememberFade(ledger, gain.gain, value, performance.now() + duration * 1000);
}

/** If a fade's wall-clock end has passed, the param is set to that target. In-flight fades are left alone. */
function reconcileFades(ledger: PendingFade[], now: number) {
  const wall = performance.now();
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    const fade = ledger[i];
    if (wall + 40 < fade.endWall) {
      continue;
    }
    fade.param.cancelScheduledValues(now);
    fade.param.setValueAtTime(fade.target, now);
    ledger.splice(i, 1);
  }
}

function composeFor(world: World, previousSeed?: number) {
  const composition = compose(world.music, randomSeed(previousSeed));
  if (isDev) {
    console.info(`[orbital-lofi] music ${world.id}: ${describeComposition(composition)}`);
    console.info(describeSilence(composition));
  }
  return composition;
}

function snapshot(worldId: WorldId, composition: Composition): NowPlayingInfo {
  return {
    worldId,
    seed: composition.seed,
    tempo: composition.bpm,
    root: composition.key,
    scale: composition.scale,
  };
}

export function useAudioEngine(initialWorld: World) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  const [status, setStatus] = useState<AudioEngineStatus>("idle");
  const [nowPlaying, setNowPlaying] = useState<NowPlayingInfo | null>(null);
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
  /** True from a world-cover start until the visible scene swaps. Holds the readout on the old world. */
  const transitioningRef = useRef(false);
  const playingRef = useRef(false);
  const startingRef = useRef(false);
  const volumeRef = useRef(DEFAULT_VOLUME);
  const restoreVolumeRef = useRef(DEFAULT_VOLUME);

  // Bumping a token invalidates in-flight async work of that kind.
  const startTokenRef = useRef(0);
  const ambienceTokenRef = useRef(0);
  const eventTokenRef = useRef(0);
  const contextsCreatedRef = useRef(0);
  const contextHookedRef = useRef(false);
  const recoveringRef = useRef(false);
  const probeRef = useRef<{ time: number; wall: number } | null>(null);
  const stallPollsRef = useRef(0);
  const kickedRef = useRef(false);
  const resumeAttemptRef = useRef(false);
  const seenAnomalyRef = useRef(0);
  const fadesRef = useRef<PendingFade[]>([]);
  const generationRef = useRef(0);
  const renderRef = useRef<RenderHold>(emptyRender(0));
  const renderInflightRef = useRef(false);
  const renderPendingRef = useRef<RenderRequest | null>(null);

  const recoverPlayback = useCallback(async (reason: string) => {
    const graph = graphRef.current;
    if (!graph || !playingRef.current || document.visibilityState === "hidden") {
      return;
    }
    if (recoveringRef.current) {
      return;
    }
    recoveringRef.current = true;
    try {
      const before = contextState(graph.context);
      if (before === "closed") {
        logAudio(`${reason}: context is closed`);
        return;
      }
      if (needsResume(before)) {
        const after = await resumeContext(graph.context);
        logAudio("resume", { reason, from: before, to: after });
        if (needsResume(contextState(graph.context))) {
          const kicked = await kickContext(graph.context);
          logAudio("resume retry via suspend", { reason, to: kicked });
        }
      }
      reconcileFades(fadesRef.current, graph.context.currentTime);
      graph.ai.settle();
      if (liveSchedulerWanted(graph, renderRef.current)) {
        const caught = graph.engine.wake();
        if (caught.skipped > 0 || caught.rewound) {
          logAudio("scheduler resync", { reason, ...caught });
        }
      }
      const revived = graph.ai.revive();
      if (revived === "restarted" || revived === "released") {
        logAudio("music source revive", { reason, revived });
      }
      probeRef.current = { time: graph.context.currentTime, wall: performance.now() };
    } finally {
      recoveringRef.current = false;
    }
  }, []);

  const onState = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) {
      return;
    }
    const state = contextState(graph.context);
    logAudio("statechange", {
      context: state,
      playing: playingRef.current,
      visible: document.visibilityState,
      time: Number(graph.context.currentTime.toFixed(2)),
    });
    if (playingRef.current && document.visibilityState === "visible" && needsResume(state)) {
      void recoverPlayback("statechange");
    }
  }, [recoverPlayback]);

  const ensureGraph = useCallback(async () => {
    if (!graphRef.current) {
      graphRef.current = createGraph(volumeRef.current);
      contextsCreatedRef.current += 1;
    }
    const graph = graphRef.current;
    if (!contextHookedRef.current) {
      graph.context.addEventListener("statechange", onState);
      contextHookedRef.current = true;
    }
    graph.engine.setRecoveryListener(() => {
      reconcileFades(fadesRef.current, graph.context.currentTime);
      graph.ai.settle();
    });
    // resume() runs synchronously inside the click/keypress so autoplay policy allows it.
    const before = contextState(graph.context);
    if (before !== "running") {
      const pending = graph.context.resume();
      if (contextState(graph.context) !== "running") {
        await finishResume(pending, graph.context);
      }
      logAudio("play resume", { from: before, to: contextState(graph.context) });
    }
    return graph;
  }, [onState]);

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

  const abandonRender = useCallback((keepVoice: boolean) => {
    const previous = renderRef.current;
    const graph = graphRef.current;
    const handedOff =
      previous.voice != null &&
      previous.handoffAt != null &&
      graph != null &&
      graph.context.currentTime >= previous.handoffAt - 0.02;
    generationRef.current += 1;
    renderPendingRef.current = null;
    if (!keepVoice || !handedOff) {
      previous.voice?.stop();
    }
    const next = emptyRender(generationRef.current);
    if (keepVoice && handedOff) {
      next.voice = previous.voice;
      next.handoffAt = previous.handoffAt;
      next.buffer = previous.buffer;
      next.state = "active";
      next.seed = previous.seed;
      next.worldId = previous.worldId;
      next.pieceSeconds = previous.pieceSeconds;
      next.sampleRate = previous.sampleRate;
      next.channels = previous.channels;
      next.bytes = previous.bytes;
      next.renderMs = previous.renderMs;
      next.scheduledEvents = previous.scheduledEvents;
      next.tailSeconds = previous.tailSeconds;
    }
    renderRef.current = next;
  }, []);

  const pumpRender = useCallback(() => {
    const run = () => {
      if (renderInflightRef.current) {
        return;
      }
      const request = renderPendingRef.current;
      renderPendingRef.current = null;
      const graph = graphRef.current;
      if (!request || !isCurrentGeneration(request.generation, generationRef.current) || !graph) {
        return;
      }
      if (!offlineRenderSupported()) {
        renderRef.current.state = "failed";
        logAudio("render unavailable", { reason: "OfflineAudioContext missing" });
        return;
      }
      renderInflightRef.current = true;
      renderRef.current.state = "rendering";
      const { generation, composition } = request;
      void renderProceduralPiece(composition, graph.context.sampleRate, graph.context)
        .then((rendered) => {
          const current = graphRef.current;
          if (!isCurrentGeneration(generation, generationRef.current) || !current || current !== graph || !playingRef.current) {
            return;
          }
          const clock = current.engine.clock();
          if (!clock) {
            renderRef.current.state = "failed";
            logAudio("render failed", { message: "live score was gone before handoff" });
            return;
          }
          const plan = nextBarHandoff(
            clock.musicalSeconds,
            clock.pieceSeconds,
            clock.barSeconds,
            current.context.currentTime,
          );
          const voice = startRenderedLoop(
            current.context,
            current.procedural,
            rendered.buffer,
            plan.audioTime,
            plan.offset,
            clock.pieceSeconds,
          );
          if (!isCurrentGeneration(generation, generationRef.current)) {
            voice.stop();
            return;
          }
          try {
            current.engine.retire(plan.audioTime + 0.02);
          } catch (error) {
            voice.stop();
            throw error;
          }
          renderRef.current.voice?.stop();
          renderRef.current = {
            ...renderRef.current,
            state: "ready",
            buffer: rendered.buffer,
            voice,
            handoffAt: plan.audioTime,
            pausedOffset: null,
            pieceSeconds: rendered.pieceSeconds,
            tailSeconds: rendered.tailSeconds,
            renderMs: rendered.renderMs,
            scheduledEvents: rendered.scheduledEvents,
            sampleRate: rendered.sampleRate,
            channels: rendered.channels,
            bytes: rendered.buffer.length * rendered.buffer.numberOfChannels * 4,
          };
          logAudio("render ready", {
            seed: composition.seed,
            piece: Number(rendered.pieceSeconds.toFixed(1)),
            tail: Number(rendered.tailSeconds.toFixed(1)),
            ms: Math.round(rendered.renderMs),
            rate: rendered.sampleRate,
            bytes: renderRef.current.bytes,
            handoffIn: Number(plan.wait.toFixed(2)),
            offset: Number(plan.offset.toFixed(2)),
          });
        })
        .catch((error: unknown) => {
          if (!isCurrentGeneration(generation, generationRef.current)) {
            return;
          }
          renderRef.current.state = "failed";
          renderRef.current.buffer = null;
          const message = error instanceof Error ? error.message : "render failed";
          logAudio("render failed", { message });
        })
        .finally(() => {
          renderInflightRef.current = false;
          if (renderPendingRef.current) {
            run();
          }
        });
    };
    run();
  }, []);

  /** Replaces whatever is playing with `composition`, ramping the music stage back up. */
  const startMusic = useCallback(
    (worldId: WorldId, composition: Composition, fadeInSeconds: number, fromStep = 0) => {
      const graph = graphRef.current;
      if (!graph) {
        return;
      }
      clearNextTimer();
      renderRef.current.voice?.stop();
      generationRef.current += 1;
      const generation = generationRef.current;
      renderRef.current = {
        ...emptyRender(generation),
        state: "rendering",
        worldId,
        seed: composition.seed,
        pieceSeconds: pieceSeconds(composition.bpm, composition.steps),
        tailSeconds: pieceTailSeconds({
          decay: composition.reverb.decay,
          softness: composition.space.softness,
        }),
      };
      graph.engine.play(composition, fromStep);
      soundingRef.current = { worldId, composition };
      setNowPlaying(snapshot(worldId, composition));
      fadeTo(fadesRef.current, graph.music, 1, fadeInSeconds);
      graph.ai.engage(getWorldById(worldId));
      renderPendingRef.current = { generation, composition };
      pumpRender();
    },
    [clearNextTimer, pumpRender],
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
    const graph = graphRef.current;
    // A decoded AI track can take the crossfade immediately. The signal stays.
    if (
      graph &&
      playingRef.current &&
      soundingRef.current?.worldId === world.id &&
      !nextTimerRef.current &&
      graph.ai.advance()
    ) {
      return;
    }

    compositionRef.current = composeFor(world, compositionRef.current?.seed);
    graph?.ai.yield();

    // Paused, starting, or mid world-transition: only the queued composition changes.
    if (!graph || !playingRef.current || soundingRef.current?.worldId !== world.id) {
      // Paused, and not under a world cover: this queue is what Play will start.
      // While a transition is open, the visible world is still the previous one.
      if (!playingRef.current && !transitioningRef.current) {
        setNowPlaying(snapshot(world.id, compositionRef.current));
      }
      return;
    }
    // A fade-out already in flight plays the latest composition when it lands.
    if (nextTimerRef.current) {
      return;
    }
    fadeTo(fadesRef.current, graph.music, 0, NEXT_FADE_OUT_S);
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

  const resumeRendered = useCallback(() => {
    const graph = graphRef.current;
    const job = renderRef.current;
    const composition = compositionRef.current;
    const world = worldRef.current;
    if (!graph || !job.buffer || job.pausedOffset == null || !composition) {
      return false;
    }
    if (job.worldId !== world.id || job.seed !== composition.seed) {
      return false;
    }
    const now = graph.context.currentTime;
    const voice = startRenderedLoop(
      graph.context,
      graph.procedural,
      job.buffer,
      now,
      job.pausedOffset,
      job.pieceSeconds ?? job.buffer.duration,
    );
    job.voice = voice;
    job.handoffAt = now;
    job.pausedOffset = null;
    job.state = "active";
    soundingRef.current = { worldId: world.id, composition };
    setNowPlaying(snapshot(world.id, composition));
    graph.ai.engage(world);
    void startAmbience(world);
    return true;
  }, [startAmbience]);

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
    const job = renderRef.current;
    const handedOff =
      graph != null &&
      job.buffer != null &&
      job.voice != null &&
      job.handoffAt != null &&
      graph.context.currentTime >= job.handoffAt - 0.02;
    if (handedOff && graph) {
      job.pausedOffset = job.voice?.offsetAt(graph.context.currentTime) ?? 0;
      job.voice?.stop();
      job.voice = null;
      job.handoffAt = null;
      job.state = "ready";
    } else {
      abandonRender(false);
    }
    if (graph) {
      graph.ai.suspend();
      graph.engine.stop();
      for (const stage of [graph.output, graph.music]) {
        stage.gain.cancelScheduledValues(graph.context.currentTime);
        stage.gain.value = 1;
      }
      fadesRef.current = fadesRef.current.filter(
        (fade) => fade.param !== graph.output.gain && fade.param !== graph.music.gain,
      );
    }
    setStatus("idle");
  }, [abandonRender, clearNextTimer, stopAmbience, stopEventSound]);

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
      if (contextState(graph.context) !== "running") {
        logAudio("play blocked", { context: contextState(graph.context) });
        if (isDev) {
          console.warn("[orbital-lofi] Audio is blocked by the browser; press Play again");
        }
        setStatus("idle");
        return;
      }
      playingRef.current = true;
      setIsPlaying(true);
      if (!resumeRendered()) {
        startWorldAudio(worldRef.current);
      }
    } catch (error) {
      if (token !== startTokenRef.current) {
        return;
      }
      startingRef.current = false;
      console.error("[orbital-lofi] Playback failed", error);
      setStatus("error");
    }
  }, [ensureGraph, resumeRendered, startWorldAudio, stopPlayback]);

  const beginWorldTransition = useCallback(
    (world: World) => {
      transitioningRef.current = true;
      worldRef.current = world;
      // Every world visit gets a fresh composition from that world's profile.
      compositionRef.current = composeFor(world, compositionRef.current?.seed);
      graphRef.current?.ai.retarget(world);
      // A pending Next is abandoned; finishWorldTransition starts the new composition.
      clearNextTimer();
      stopEventSound();
      const graph = graphRef.current;
      if (!graph) {
        return;
      }
      preloadWorldAmbience(graph.context, world);
      if (playingRef.current) {
        abandonRender(true);
        fadeTo(fadesRef.current, graph.output, 0, TRANSITION_FADE_S);
      } else {
        abandonRender(false);
      }
    },
    [abandonRender, clearNextTimer, stopEventSound],
  );

  const finishWorldTransition = useCallback(
    (world: World) => {
      transitioningRef.current = false;
      worldRef.current = world;
      const graph = graphRef.current;
      if (!playingRef.current) {
        if (compositionRef.current) {
          setNowPlaying(snapshot(world.id, compositionRef.current));
        }
        if (graph) {
          fadeTo(fadesRef.current, graph.output, 1, 0.05);
        }
        return;
      }
      // Swapped under the cover while output is faded out, so the restart is inaudible.
      startWorldAudio(world);
      if (graph) {
        fadeTo(fadesRef.current, graph.output, 1, TRANSITION_FADE_S);
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
      rememberFade(fadesRef.current, graph.master.gain, clamped, performance.now() + 250);
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

  const describeAudio = useCallback(() => {
    const graph = graphRef.current;
    const health = graph?.engine.health();
    const now = graph ? graph.context.currentTime : null;
    const cursor = health?.nextTime ?? null;
    const drift = now != null && cursor != null ? cursor - now : null;
    const probe = probeRef.current;
    let advancing = "unknown";
    if (graph && probe && performance.now() - probe.wall > 400) {
      advancing = graph.context.currentTime - probe.time > 0.05 ? "yes" : "no";
    }
    const ai = graph?.ai.status();
    const ambienceVoices = voicesRef.current.size;
    const layers = graph?.engine.layers();
    const fmt = (value: number | null) => (value == null ? "n/a" : value.toFixed(2));
    const ago = (when: number | null) => {
      if (when == null || now == null) {
        return "none";
      }
      const delta = now - when;
      if (!Number.isFinite(delta)) {
        return "none";
      }
      return delta < 0 ? "ahead" : `${delta.toFixed(1)}s ago`;
    };
    const yesNo = (value: boolean) => (value ? "yes" : "no");
    const sustain = (layer: "chords" | "bass" | "lead") => {
      if (!layers) {
        return "n/a";
      }
      return `last ${ago(layers.last[layer])} / expected ${yesNo(layers.expected[layer])} / sounding ${yesNo(layers.sounding[layer])}`;
    };
    return [
      `Context: ${graph ? contextState(graph.context) : "none"}`,
      `Context time: ${fmt(now)}`,
      `Time advancing: ${advancing}`,
      `Playing: ${playingRef.current}`,
      `Visible: ${typeof document === "undefined" ? "n/a" : document.visibilityState}`,
      `Scheduler: ${health?.active ? "active" : "stopped"}`,
      `Scheduler cursor: ${fmt(cursor)}`,
      `Cursor drift: ${fmt(drift)}`,
      `Master gain: ${graph ? graph.master.gain.value.toFixed(2) : "n/a"}`,
      `Output gain: ${graph ? graph.output.gain.value.toFixed(2) : "n/a"}`,
      `Music gain: ${graph ? graph.music.gain.value.toFixed(2) : "n/a"}`,
      `Engine gain: ${layers ? layers.buses.out.toFixed(2) : "n/a"}`,
      `Music source: ${ai?.source ?? "none"}`,
      `AI: ${ai ? `${ai.source}, ${ai.engaged ? "engaged" : "idle"}, ${ai.voices} voice${ai.voices === 1 ? "" : "s"}, procedural ${ai.proceduralGain.toFixed(2)}, bus ${ai.aiBusGain.toFixed(2)}` : "none"}`,
      `Contexts created: ${contextsCreatedRef.current}`,
      "Layers:",
      `  texture: ${layers?.texture ?? "off"}`,
      `  ambience: ${ambienceVoices} active`,
      `  reverb: send ${layers ? layers.reverbSend.toFixed(2) : "n/a"}, return connected`,
      `  chords: ${sustain("chords")}`,
      `  bass: ${sustain("bass")}`,
      `  lead: ${sustain("lead")}`,
      `  drums: last ${ago(layers?.last.drums ?? null)} (kick ${ago(layers?.last.kick ?? null)}, snare ${ago(layers?.last.snare ?? null)}, hats ${ago(layers?.last.hats ?? null)})`,
      `  buses: kick ${layers ? layers.buses.kick.toFixed(2) : "n/a"}, snare ${layers ? layers.buses.snare.toFixed(2) : "n/a"}, hats ${layers ? layers.buses.hats.toFixed(2) : "n/a"}, bass ${layers ? layers.buses.bass.toFixed(2) : "n/a"}, chords ${layers ? layers.buses.chords.toFixed(2) : "n/a"}, lead ${layers ? layers.buses.lead.toFixed(2) : "n/a"}`,
      ...describeRender(graph, renderRef.current),
    ].join("\n");
  }, []);

  const watchAudio = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) {
      return;
    }
    const health = graph.engine.health();
    if (health.anomaly && health.anomalySerial !== seenAnomalyRef.current) {
      seenAnomalyRef.current = health.anomalySerial;
      logAudio("scheduler catch-up", health.anomaly);
    }
    const now = graph.context.currentTime;
    const wall = performance.now();
    const probe = probeRef.current;
    const visible = document.visibilityState === "visible";
    const state = contextState(graph.context);
    if (playingRef.current && visible && needsResume(state)) {
      if (!resumeAttemptRef.current) {
        resumeAttemptRef.current = true;
        void recoverPlayback("watch");
      }
    } else if (state === "running") {
      resumeAttemptRef.current = false;
    }
    if (probe && playingRef.current && visible) {
      const elapsed = (wall - probe.wall) / 1000;
      const advanced = now - probe.time;
      if (state === "running" && elapsed > 3 && advanced < 0.05) {
        stallPollsRef.current += 1;
        if (stallPollsRef.current === 1) {
          logAudio("context time stalled while running", { time: Number(now.toFixed(2)) });
        }
        if (stallPollsRef.current >= 2 && !kickedRef.current) {
          kickedRef.current = true;
          logAudio("single suspend/resume; context clock had stopped");
          void kickContext(graph.context).then((next) => {
            logAudio("kick result", { context: next });
            if (playingRef.current) {
              reconcileFades(fadesRef.current, graph.context.currentTime);
              graph.ai.settle();
              if (liveSchedulerWanted(graph, renderRef.current)) {
                graph.engine.wake();
              }
            }
          });
        }
      } else if (advanced > 0.2) {
        stallPollsRef.current = 0;
        kickedRef.current = false;
      }
      const job = renderRef.current;
      if (job.state === "ready" && job.handoffAt != null && now >= job.handoffAt) {
        job.state = "active";
      }
      const timerStale = health.lastTickWall != null && wall - health.lastTickWall > 3000;
      const cursorBehind = health.nextTime != null && health.nextTime - now < -1.5;
      if (state === "running" && liveSchedulerWanted(graph, job) && (timerStale || cursorBehind)) {
        reconcileFades(fadesRef.current, graph.context.currentTime);
        graph.ai.settle();
        const caught = graph.engine.wake();
        logAudio("scheduler restart", { timerStale, cursorBehind, ...caught });
      }
    }
    probeRef.current = { time: now, wall };
  }, [recoverPlayback]);

  useEffect(() => {
    if (!isDev) {
      return;
    }
    const handle: MusicDevHandle = {
      current: () => {
        const composition = soundingRef.current?.composition ?? compositionRef.current;
        return composition ? describeComposition(composition) : null;
      },
      silence: () => {
        const composition = soundingRef.current?.composition ?? compositionRef.current;
        return composition ? describeSilence(composition) : null;
      },
      source: () => graphRef.current?.ai.source() ?? "procedural",
      next: nextComposition,
      audioDebug: () => {
        const text = describeAudio();
        console.info(`[orbital-lofi] audioDebug\n${text}`);
        return text;
      },
      simulateStall: (seconds: number) => {
        const graph = graphRef.current;
        if (!graph || !playingRef.current) {
          logAudio("simulateStall skipped; playback is stopped");
          return null;
        }
        const result = graph.engine.debugStall(seconds);
        logAudio("simulateStall", { seconds, ...result });
        return result;
      },
      outputKick: async () => {
        const graph = graphRef.current;
        if (!graph) {
          return "no context";
        }
        const before = contextState(graph.context);
        const after = before === "running" ? await kickContext(graph.context) : await resumeContext(graph.context);
        if (playingRef.current) {
          reconcileFades(fadesRef.current, graph.context.currentTime);
          if (liveSchedulerWanted(graph, renderRef.current)) {
            graph.engine.wake();
          }
          graph.ai.revive();
        }
        const line = `${before} → ${after}`;
        logAudio("outputKick", { from: before, to: after });
        return line;
      },
    };
    window.orbitalMusic = handle;
    return () => {
      if (window.orbitalMusic === handle) {
        delete window.orbitalMusic;
      }
    };
  }, [describeAudio, nextComposition]);

  useEffect(() => {
    // Music keeps playing across a hidden tab. Safari may suspend, interrupt, or
    // leave the context running while timers slow down. Resume only once visible.
    const onVisibility = () => {
      const graph = graphRef.current;
      logAudio("visibilitychange", {
        state: document.visibilityState,
        context: graph ? contextState(graph.context) : "none",
        playing: playingRef.current,
        time: graph ? Number(graph.context.currentTime.toFixed(2)) : null,
      });
      if (document.visibilityState === "visible") {
        void recoverPlayback("visible");
      }
    };
    const onPageHide = (event: PageTransitionEvent) => {
      const graph = graphRef.current;
      logAudio("pagehide", {
        persisted: event.persisted,
        context: graph ? contextState(graph.context) : "none",
        playing: playingRef.current,
      });
    };
    const onPageShow = (event: PageTransitionEvent) => {
      logAudio("pageshow", { persisted: event.persisted, playing: playingRef.current });
      if (document.visibilityState === "visible") {
        void recoverPlayback("pageshow");
      }
    };
    const onFocus = () => {
      const graph = graphRef.current;
      logAudio("focus", {
        context: graph ? contextState(graph.context) : "none",
        playing: playingRef.current,
      });
    };
    const onBlur = () => {
      const graph = graphRef.current;
      logAudio("blur", {
        context: graph ? contextState(graph.context) : "none",
        playing: playingRef.current,
      });
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    const watchdog = window.setInterval(() => watchAudio(), 5000);
    const voices = voicesRef.current;
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.clearInterval(watchdog);
      startTokenRef.current += 1;
      generationRef.current += 1;
      renderPendingRef.current = null;
      renderRef.current.voice?.stop();
      renderRef.current = emptyRender(generationRef.current);
      ambienceTokenRef.current += 1;
      startingRef.current = false;
      playingRef.current = false;
      soundingRef.current = null;
      window.clearTimeout(nextTimerRef.current);
      nextTimerRef.current = 0;
      stopAmbienceVoices(voices);
      stopEventSound();
      const graph = graphRef.current;
      if (graph && contextHookedRef.current) {
        graph.context.removeEventListener("statechange", onState);
        contextHookedRef.current = false;
      }
      graphRef.current = null;
      graph?.ai.dispose();
      graph?.engine.dispose();
      void graph?.context.close().catch(() => {});
      setIsPlaying(false);
      setStatus("idle");
    };
  }, [onState, recoverPlayback, stopEventSound, watchAudio]);

  return {
    isPlaying,
    volume,
    status,
    nowPlaying,
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
