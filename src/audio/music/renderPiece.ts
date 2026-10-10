import { createMusicEngine, type OfflineBuildMarks } from "@/audio/music/musicEngine";
import type { Composition } from "@/audio/music/composer";
import { foldTail, loopOffset, pieceSeconds, pieceTailSeconds, renderPace } from "@/audio/music/renderMath";

export type RenderProfile = OfflineBuildMarks & {
  contextMs: number;
  /** `startRendering()` only. */
  renderMs: number;
  foldMs: number;
  copyMs: number;
  totalMs: number;
  /** Piece plus tail: the length `startRendering()` actually produces. */
  audioSeconds: number;
};

export type RenderedPiece = {
  buffer: AudioBuffer;
  pieceSeconds: number;
  tailSeconds: number;
  renderMs: number;
  scheduledEvents: number;
  sampleRate: number;
  channels: number;
  profile: RenderProfile;
};

const phaseText = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`);

/** Development snapshot of one offline render. Not shown in the production HUD. */
export function formatRenderProfile(profile: RenderProfile) {
  const pace = renderPace(profile.renderMs, profile.audioSeconds);
  const lines = [
    "Offline render profile:",
    `  context creation: ${phaseText(profile.contextMs)}`,
    `  graph build: ${phaseText(profile.graphMs)}`,
    `  noise buffers: ${phaseText(profile.noiseMs)}`,
    `  reverb impulse: ${phaseText(profile.impulseMs)}`,
    `  texture bed: ${phaseText(profile.textureMs)}`,
    `  schedule score: ${phaseText(profile.scheduleMs)}`,
    `  startRendering: ${phaseText(profile.renderMs)}`,
    `  tail fold: ${phaseText(profile.foldMs)}`,
    `  buffer copy: ${phaseText(profile.copyMs)}`,
    `  total: ${phaseText(profile.totalMs)}`,
  ];
  if (pace) {
    lines.push(`Render factor: ${pace.factor.toFixed(2)}x real time`);
    lines.push(`Audio rendered at: ${pace.realtime.toFixed(1)}x realtime`);
  }
  return lines;
}

export function offlineRenderSupported() {
  return typeof OfflineAudioContext !== "undefined";
}

/**
 * Render `composition` on a fresh offline context. The score object is the one
 * the live engine is already playing. This does not call the composer.
 */
export async function renderProceduralPiece(
  composition: Composition,
  sampleRate: number,
  host: BaseAudioContext,
): Promise<RenderedPiece> {
  const piece = pieceSeconds(composition.bpm, composition.steps);
  const tail = pieceTailSeconds({
    decay: composition.reverb.decay,
    softness: composition.space.softness,
  });
  const rate = sampleRate > 0 ? sampleRate : host.sampleRate;
  const frames = Math.ceil((piece + tail) * rate);
  const totalStarted = performance.now();
  let mark = totalStarted;
  const offline = new OfflineAudioContext(2, Math.max(1, frames), rate);
  const contextMs = performance.now() - mark;
  const marks: OfflineBuildMarks = {
    graphMs: 0,
    noiseMs: 0,
    impulseMs: 0,
    textureMs: 0,
    scheduleMs: 0,
  };
  const engine = createMusicEngine(offline, offline.destination, marks);
  const scheduledEvents = engine.performScore(composition);
  mark = performance.now();
  let rendered: AudioBuffer;
  let renderMs = 0;
  try {
    rendered = await offline.startRendering();
  } finally {
    renderMs = performance.now() - mark;
    try {
      engine.dispose();
    } catch {
      // The offline context is finished. Dropping it is enough.
    }
  }
  mark = performance.now();
  const pieceFrames = Math.max(1, Math.min(rendered.length, Math.round(piece * rendered.sampleRate)));
  const foldedChannels: Float32Array[] = [];
  let peak = 0;
  for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
    const data = rendered.getChannelData(channel);
    const folded = foldTail(data.subarray(0, pieceFrames), data.subarray(pieceFrames), false);
    foldedChannels.push(folded.samples);
    peak = Math.max(peak, folded.peak);
  }
  const foldMs = performance.now() - mark;
  const gain = peak > 0.98 ? 0.98 / peak : 1;
  mark = performance.now();
  const buffer = host.createBuffer(rendered.numberOfChannels, pieceFrames, rendered.sampleRate);
  for (let channel = 0; channel < foldedChannels.length; channel += 1) {
    const samples = foldedChannels[channel];
    if (gain < 1) {
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] *= gain;
      }
    }
    buffer.getChannelData(channel).set(samples);
  }
  const copyMs = performance.now() - mark;
  const profile: RenderProfile = {
    ...marks,
    contextMs,
    renderMs,
    foldMs,
    copyMs,
    totalMs: performance.now() - totalStarted,
    audioSeconds: piece + tail,
  };
  return {
    buffer,
    pieceSeconds: piece,
    tailSeconds: tail,
    renderMs,
    scheduledEvents,
    sampleRate: rendered.sampleRate,
    channels: rendered.numberOfChannels,
    profile,
  };
}

export type LoopVoice = {
  stop: (when?: number) => void;
  offsetAt: (now: number) => number;
  looping: boolean;
};

/** One looping play of a rendered piece, through the caller's bus. */
export function startRenderedLoop(
  context: BaseAudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  when: number,
  offset: number,
  piece: number,
): LoopVoice {
  const gain = context.createGain();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = buffer.duration;
  source.connect(gain);
  gain.connect(destination);
  const start = Math.max(when, context.currentTime);
  const at = loopOffset(offset, start, start, piece > 0 ? piece : buffer.duration);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(1, start + 0.02);
  source.start(start, Math.min(at, Math.max(0, buffer.duration - 0.001)));
  return {
    stop(atTime?: number) {
      const t = atTime ?? context.currentTime;
      try {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + 0.02);
        source.stop(t + 0.03);
      } catch {
        // already stopped
      }
      window.setTimeout(() => {
        try {
          source.disconnect();
          gain.disconnect();
        } catch {
          // already disconnected
        }
      }, 80);
    },
    offsetAt(now: number) {
      return loopOffset(at, start, now, piece > 0 ? piece : buffer.duration);
    },
    looping: source.loop,
  };
}
