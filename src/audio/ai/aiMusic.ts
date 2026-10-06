import { requestMusicClip, type GeneratedClip } from "@/audio/ai/musicgenClient";
import type { MusicgenStatus } from "@/audio/ai/musicgenMessages";

const CROSSFADE_S = 2;
const TARGET_PEAK = 0.65;

export type AiSession = {
  worldId: string;
  seed: number;
  prompt: string;
};

export type AiSourceStatus = "procedural" | "generating" | "enhanced" | "unavailable";

export type AiMusic = {
  /** Drop clips from any previous world or seed. Does not cut audio that is still fading out. */
  retarget: (session: AiSession) => void;
  /** Procedural playback is up. Resume an AI clip for this session, or keep the procedural underlay. */
  engage: (session: AiSession) => void;
  /** Stop speakers. A clip that finishes while paused is kept for this session. */
  suspend: () => void;
  status: () => AiSourceStatus;
  dispose: () => void;
};

type Voice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
};

function ramp(param: AudioParam, value: number, seconds: number, now: number) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  if (seconds <= 0) {
    param.setValueAtTime(value, now);
    return;
  }
  param.linearRampToValueAtTime(value, now + seconds);
}

function toBuffer(context: AudioContext, clip: GeneratedClip) {
  let peak = 0;
  for (let i = 0; i < clip.samples.length; i += 1) {
    peak = Math.max(peak, Math.abs(clip.samples[i]));
  }
  const scale = peak > 0.001 ? Math.min(1, TARGET_PEAK / peak) : 1;
  const buffer = context.createBuffer(1, clip.samples.length, clip.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < clip.samples.length; i += 1) {
    channel[i] = clip.samples[i] * scale;
  }
  return buffer;
}

/**
 * Procedural music keeps running underneath. AI clips crossfade over it and
 * back again. Only the latest session id is allowed to become audible.
 */
export function createAiMusic(
  context: AudioContext,
  procedural: GainNode,
  aiBus: GainNode,
  log: (message: string) => void,
  onStatus?: (status: AiSourceStatus) => void,
): AiMusic {
  let epoch = 0;
  let key = "";
  let prompt = "";
  let engaged = false;
  let failed = false;
  let phase: "procedural" | "ai" = "procedural";
  let clip: AudioBuffer | null = null;
  let upcoming: AudioBuffer | null = null;
  let offset = 0;
  let startedAt: number | null = null;
  let voiceToken = 0;
  let handoffTimer = 0;
  let requesting = false;
  let published: AiSourceStatus | null = null;
  const voices: Voice[] = [];

  const sessionKey = (session: AiSession) => `${session.worldId}:${session.seed}`;

  const readStatus = (): AiSourceStatus => {
    if (failed) {
      return "unavailable";
    }
    if (phase === "ai") {
      return "enhanced";
    }
    if (requesting) {
      return "generating";
    }
    return "procedural";
  };

  const publish = () => {
    const next = readStatus();
    if (next === published) {
      return;
    }
    published = next;
    onStatus?.(next);
  };

  const clearHandoff = () => {
    window.clearTimeout(handoffTimer);
    handoffTimer = 0;
  };

  const elapsed = () => (startedAt == null ? offset : offset + (context.currentTime - startedAt));

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
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + Math.max(0.03, fadeIn));
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
    return { source, gain };
  };

  const fadeOutVoice = (voice: Voice) => {
    const now = context.currentTime;
    ramp(voice.gain.gain, 0, CROSSFADE_S, now);
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

  const requestNext = () => {
    if (requesting || failed || !prompt) {
      return;
    }
    const requestEpoch = epoch;
    const requestPrompt = prompt;
    requesting = true;
    const started = performance.now();
    log(`ai generation ${requestEpoch} started`);
    publish();
    void requestMusicClip(requestEpoch, requestPrompt, (status: MusicgenStatus) => {
      if (requestEpoch === epoch) {
        log(`ai ${status}`);
      }
    })
      .then((generated) => {
        requesting = false;
        if (requestEpoch !== epoch) {
          log(`ai generation ${requestEpoch} dropped`);
          requestNext();
          publish();
          return;
        }
        if (!generated) {
          publish();
          return;
        }
        log(`ai generation ${requestEpoch} ready in ${((performance.now() - started) / 1000).toFixed(1)}s`);
        accept(toBuffer(context, generated));
        publish();
      })
      .catch((error: unknown) => {
        requesting = false;
        if (requestEpoch !== epoch) {
          requestNext();
          publish();
          return;
        }
        failed = true;
        const message = error instanceof Error ? error.message : "Music generation failed";
        log(`ai unavailable: ${message}`);
        publish();
      });
  };

  const fadeInClip = (buffer: AudioBuffer, at: number) => {
    const now = context.currentTime;
    phase = "ai";
    clip = buffer;
    ramp(procedural.gain, 0, CROSSFADE_S, now);
    ramp(aiBus.gain, 1, CROSSFADE_S, now);
    startVoice(buffer, at, 0.03);
    if (!upcoming) {
      requestNext();
    }
    publish();
  };

  const fadeToProcedural = () => {
    const now = context.currentTime;
    phase = "procedural";
    clip = null;
    offset = 0;
    startedAt = null;
    ramp(procedural.gain, 1, CROSSFADE_S, now);
    ramp(aiBus.gain, 0, CROSSFADE_S, now);
    for (const voice of voices.splice(0)) {
      fadeOutVoice(voice);
    }
    voiceToken += 1;
    clearHandoff();
    if (!failed) {
      requestNext();
    }
    publish();
  };

  function handoff() {
    if (!engaged || phase !== "ai") {
      return;
    }
    clearHandoff();
    const next = upcoming;
    upcoming = null;
    if (!next) {
      fadeToProcedural();
      return;
    }
    const previous = voices.splice(0);
    voiceToken += 1;
    clip = next;
    startVoice(next, 0, CROSSFADE_S);
    for (const voice of previous) {
      fadeOutVoice(voice);
    }
    requestNext();
  }

  const accept = (buffer: AudioBuffer) => {
    if (phase === "ai" && clip) {
      if (!upcoming) {
        upcoming = buffer;
      }
      return;
    }
    clip = buffer;
    if (engaged) {
      fadeInClip(buffer, 0);
    }
    publish();
  };

  const retarget = (session: AiSession) => {
    const nextKey = sessionKey(session);
    if (nextKey === key) {
      return;
    }
    epoch += 1;
    key = nextKey;
    prompt = session.prompt;
    failed = false;
    engaged = false;
    phase = "procedural";
    clip = null;
    upcoming = null;
    offset = 0;
    startedAt = null;
    clearHandoff();
    voiceToken += 1;
    // The outgoing clip is disarmed. If it ends before the next engage, bring the underlay back.
    for (const voice of voices) {
      voice.source.onended = () => {
        ramp(procedural.gain, 1, 0.5, context.currentTime);
      };
    }
    requestNext();
    publish();
  };

  return {
    retarget,
    engage(session) {
      const nextKey = sessionKey(session);
      const changed = nextKey !== key;
      if (changed) {
        retarget(session);
      }
      engaged = true;
      if (!changed && phase === "ai" && clip) {
        if (elapsed() >= clip.duration - 0.3) {
          if (upcoming) {
            clip = upcoming;
            upcoming = null;
            offset = 0;
          } else {
            clip = null;
          }
        }
        if (clip && elapsed() < clip.duration - 0.3) {
          ramp(procedural.gain, 0, 0, context.currentTime);
          ramp(aiBus.gain, 1, 0, context.currentTime);
          startVoice(clip, elapsed(), 0.03);
          if (!upcoming) {
            requestNext();
          }
          publish();
          return;
        }
      }
      stopVoices();
      offset = 0;
      phase = "procedural";
      ramp(procedural.gain, 1, 0, context.currentTime);
      ramp(aiBus.gain, 0, 0, context.currentTime);
      if (clip) {
        fadeInClip(clip, 0);
      } else if (!requesting && !failed) {
        requestNext();
      }
      publish();
    },
    suspend() {
      if (startedAt != null) {
        offset = elapsed();
        startedAt = null;
      }
      engaged = false;
      stopVoices();
    },
    status() {
      return readStatus();
    },
    dispose() {
      epoch += 1;
      engaged = false;
      prompt = "";
      key = "";
      clip = null;
      upcoming = null;
      stopVoices();
      aiBus.disconnect();
      procedural.disconnect();
    },
  };
}
