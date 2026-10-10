import { loadAudioBuffer } from "@/audio/ambienceEngine";
import type { AiMusicTrack, World } from "@/worlds/types";

const CROSSFADE_S = 2;

export type MusicSource = "ai" | "procedural";

export type AiLibrary = {
  /** Drop the previous world's tracks. Does not cut audio that is still fading out. */
  retarget: (world: World) => void;
  /** Playback is up. Start a decoded file immediately, or leave procedural running until one is. */
  engage: (world: World) => void;
  /**
   * Crossfade to another decoded track. False when none is ready, so the caller
   * can start a new procedural piece without waiting.
   */
  advance: () => boolean;
  /** The next Play should not resume the track that was just skipped. */
  yield: () => void;
  suspend: () => void;
  source: () => MusicSource;
  /** Restart a track whose buffer died, or confirm the current voice is still attached. */
  revive: () => "playing" | "restarted" | "released" | "idle";
  /** Snap procedural and AI bus ramps whose wall-clock end has already passed. */
  settle: () => void;
  status: () => {
    source: MusicSource;
    engaged: boolean;
    voices: number;
    loading: boolean;
    proceduralGain: number;
    aiBusGain: number;
  };
  dispose: () => void;
};

type Entry = { track: AiMusicTrack; buffer: AudioBuffer };

type Voice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
};

type LoadBuffer = (context: BaseAudioContext, src: string) => Promise<AudioBuffer>;

type FadeMark = { param: AudioParam; target: number; endWall: number };

function ramp(param: AudioParam, value: number, seconds: number, now: number, fades: FadeMark[]) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  const duration = Math.max(0, seconds);
  const index = fades.findIndex((fade) => fade.param === param);
  if (duration <= 0) {
    param.setValueAtTime(value, now);
    if (index >= 0) {
      fades.splice(index, 1);
    }
    return;
  }
  param.linearRampToValueAtTime(value, now + duration);
  const mark = { param, target: value, endWall: performance.now() + duration * 1000 };
  if (index >= 0) {
    fades[index] = mark;
  } else {
    fades.push(mark);
  }
}

function settleFades(fades: FadeMark[], now: number) {
  const wall = performance.now();
  for (let i = fades.length - 1; i >= 0; i -= 1) {
    const fade = fades[i];
    if (wall + 40 < fade.endWall) {
      continue;
    }
    fade.param.cancelScheduledValues(now);
    fade.param.setValueAtTime(fade.target, now);
    fades.splice(i, 1);
  }
}

function shuffle<T>(items: readonly T[]) {
  const next = items.slice();
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = next[i];
    next[i] = next[j];
    next[j] = swap;
  }
  return next;
}

/**
 * Pre-generated world tracks on the AI bus. Procedural music keeps running
 * underneath. Nothing here loads a model or starts inference.
 */
export function createAiLibrary(
  context: AudioContext,
  procedural: GainNode,
  aiBus: GainNode,
  log: (message: string) => void,
  load: LoadBuffer = loadAudioBuffer,
): AiLibrary {
  let epoch = 0;
  let worldId = "";
  let tracks: AiMusicTrack[] = [];
  let bag: AiMusicTrack[] = [];
  let lastId = "";
  const failed = new Set<string>();
  const decoded = new Map<string, AudioBuffer>();
  let engaged = false;
  let phase: MusicSource = "procedural";
  let current: Entry | null = null;
  let upcoming: Entry | null = null;
  let loading = false;
  let entrance = false;
  let offset = 0;
  let startedAt: number | null = null;
  let voiceToken = 0;
  let handoffTimer = 0;
  const voices: Voice[] = [];
  const fades: FadeMark[] = [];
  const fade = (param: AudioParam, value: number, seconds: number, now: number) => {
    ramp(param, value, seconds, now, fades);
  };

  const elapsed = () => (startedAt == null ? offset : offset + (context.currentTime - startedAt));

  const clearHandoff = () => {
    window.clearTimeout(handoffTimer);
    handoffTimer = 0;
  };

  const usableTracks = () => tracks.filter((track) => !failed.has(track.src));

  const takeNext = (): AiMusicTrack | null => {
    const usable = usableTracks();
    if (usable.length === 0) {
      return null;
    }
    while (bag.length > 0 && failed.has(bag[0].src)) {
      bag.shift();
    }
    if (bag.length === 0) {
      bag = shuffle(usable);
      if (bag.length > 1 && bag[0]?.id === lastId) {
        const first = bag.shift();
        if (first) {
          bag.push(first);
        }
      }
    }
    const track = bag.shift() ?? null;
    if (track) {
      lastId = track.id;
    }
    return track;
  };

  const stopVoices = () => {
    voiceToken += 1;
    clearHandoff();
    startedAt = null;
    for (const voice of voices.splice(0)) {
      voice.source.onended = null;
      try {
        voice.source.stop();
      } catch {
        // already stopped
      }
      voice.source.disconnect();
      voice.gain.disconnect();
    }
  };

  const fadeOutVoice = (voice: Voice) => {
    fade(voice.gain.gain, 0, CROSSFADE_S, context.currentTime);
    window.setTimeout(() => {
      voice.source.onended = null;
      try {
        voice.source.stop();
      } catch {
        // already stopped
      }
      voice.source.disconnect();
      voice.gain.disconnect();
    }, CROSSFADE_S * 1000 + 40);
  };

  const scheduleHandoff = (buffer: AudioBuffer) => {
    clearHandoff();
    const remaining = buffer.duration - elapsed() - CROSSFADE_S;
    handoffTimer = window.setTimeout(() => {
      handoffTimer = 0;
      handoff();
    }, Math.max(0.05, remaining) * 1000);
  };

  const startVoice = (buffer: AudioBuffer, at: number, fadeIn: number) => {
    const now = context.currentTime;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(aiBus);
    const startAt = Math.min(Math.max(0, at), Math.max(0, buffer.duration - 0.05));
    gain.gain.value = 0;
    fade(gain.gain, 1, Math.max(0.03, fadeIn), now);
    const token = (voiceToken += 1);
    source.onended = () => {
      if (token !== voiceToken) {
        return;
      }
      handoff();
    };
    source.start(now, startAt);
    voices.push({ source, gain });
    offset = startAt;
    startedAt = now;
    scheduleHandoff(buffer);
  };

  const disarm = () => {
    clearHandoff();
    voiceToken += 1;
    for (const voice of voices) {
      voice.source.onended = () => {
        fade(procedural.gain, 1, 0.5, context.currentTime);
      };
    }
  };

  function begin(entry: Entry, fadeSeconds: number) {
    const now = context.currentTime;
    phase = "ai";
    current = entry;
    const previous = voices.splice(0);
    fade(procedural.gain, 0, fadeSeconds, now);
    fade(aiBus.gain, 1, fadeSeconds, now);
    startVoice(entry.buffer, 0, previous.length > 0 ? CROSSFADE_S : 0.03);
    for (const voice of previous) {
      voice.source.onended = null;
      fadeOutVoice(voice);
    }
    log(`ai track ${entry.track.id}`);
    fillNext();
  }

  function fadeToProcedural() {
    const now = context.currentTime;
    phase = "procedural";
    current = null;
    offset = 0;
    startedAt = null;
    fade(procedural.gain, 1, CROSSFADE_S, now);
    fade(aiBus.gain, 0, CROSSFADE_S, now);
    for (const voice of voices.splice(0)) {
      fadeOutVoice(voice);
    }
    voiceToken += 1;
    clearHandoff();
  }

  function handoff() {
    if (!engaged || phase !== "ai") {
      return;
    }
    clearHandoff();
    const next = upcoming;
    upcoming = null;
    if (!next) {
      fadeToProcedural();
      fillNext();
      return;
    }
    begin(next, CROSSFADE_S);
  }

  function deliver(entry: Entry, autostart: boolean) {
    upcoming = entry;
    if (autostart && engaged && phase === "procedural") {
      upcoming = null;
      begin(entry, entrance ? 0 : CROSSFADE_S);
    }
  }

  function fillNext(autostart = true) {
    if (loading || upcoming) {
      return;
    }
    const track = takeNext();
    if (!track) {
      return;
    }
    const cached = decoded.get(track.src);
    if (cached) {
      deliver({ track, buffer: cached }, autostart);
      return;
    }
    loading = true;
    const requestEpoch = epoch;
    void load(context, track.src)
      .then((buffer) => {
        if (requestEpoch !== epoch) {
          return;
        }
        loading = false;
        decoded.set(track.src, buffer);
        deliver({ track, buffer }, autostart);
      })
      .catch(() => {
        if (requestEpoch !== epoch) {
          return;
        }
        loading = false;
        failed.add(track.src);
        log(`ai track failed: ${track.id}`);
        fillNext(autostart);
      });
  }

  const resetQueue = (world: World) => {
    epoch += 1;
    worldId = world.id;
    tracks = [...(world.aiMusic ?? [])];
    bag = [];
    lastId = "";
    loading = false;
    upcoming = null;
    current = null;
    offset = 0;
    startedAt = null;
    phase = "procedural";
    engaged = false;
    disarm();
  };

  return {
    retarget(world) {
      if (world.id === worldId && tracks.length === (world.aiMusic?.length ?? 0)) {
        return;
      }
      resetQueue(world);
      fillNext();
    },
    engage(world) {
      if (world.id !== worldId) {
        resetQueue(world);
      }
      engaged = true;
      entrance = true;
      if (phase === "ai" && current && elapsed() < current.buffer.duration - 0.3) {
        fade(procedural.gain, 0, 0, context.currentTime);
        fade(aiBus.gain, 1, 0, context.currentTime);
        startVoice(current.buffer, elapsed(), 0.03);
        fillNext();
        entrance = false;
        return;
      }
      stopVoices();
      phase = "procedural";
      fade(procedural.gain, 1, 0, context.currentTime);
      fade(aiBus.gain, 0, 0, context.currentTime);
      if (upcoming) {
        const next = upcoming;
        upcoming = null;
        begin(next, 0);
        entrance = false;
        return;
      }
      fillNext();
      entrance = false;
    },
    advance() {
      if (!engaged) {
        return false;
      }
      if (!upcoming) {
        fillNext(false);
      }
      if (!upcoming) {
        return false;
      }
      const next = upcoming;
      upcoming = null;
      begin(next, CROSSFADE_S);
      return true;
    },
    yield() {
      epoch += 1;
      engaged = false;
      phase = "procedural";
      current = null;
      upcoming = null;
      loading = false;
      offset = 0;
      startedAt = null;
      disarm();
    },
    suspend() {
      if (startedAt != null) {
        offset = elapsed();
        startedAt = null;
      }
      engaged = false;
      stopVoices();
    },
    source() {
      return phase;
    },
    settle() {
      settleFades(fades, context.currentTime);
    },
    revive() {
      settleFades(fades, context.currentTime);
      if (!engaged) {
        return "idle";
      }
      if (phase === "ai") {
        if (voices.length > 0) {
          return "playing";
        }
        if (current && elapsed() < current.buffer.duration - 0.3) {
          fade(procedural.gain, 0, 0, context.currentTime);
          fade(aiBus.gain, 1, 0, context.currentTime);
          startVoice(current.buffer, elapsed(), 0.03);
          return "restarted";
        }
        fadeToProcedural();
        return "released";
      }
      if (voices.length === 0 && aiBus.gain.value > 0.01) {
        fade(procedural.gain, 1, 0, context.currentTime);
        fade(aiBus.gain, 0, 0, context.currentTime);
        return "released";
      }
      return "playing";
    },
    status() {
      return {
        source: phase,
        engaged,
        voices: voices.length,
        loading,
        proceduralGain: procedural.gain.value,
        aiBusGain: aiBus.gain.value,
      };
    },
    dispose() {
      epoch += 1;
      engaged = false;
      tracks = [];
      current = null;
      upcoming = null;
      stopVoices();
      aiBus.disconnect();
      procedural.disconnect();
    },
  };
}
