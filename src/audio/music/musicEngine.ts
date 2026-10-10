import type { Composition } from "@/audio/music/composer";
import { createInstruments, type RegisterSource } from "@/audio/music/instruments";
import { createRng } from "@/audio/music/random";

/** How far ahead notes are committed to the AudioContext clock, and how often we top up. */
const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
const START_DELAY_S = 0.1;
const STOP_FADE_S = 0.04;
/** textureAmount 1 lands here. The bed is quiet enough to sit under the mix. */
const TEXTURE_PEAK = 0.012;
/** Long enough that a smooth bed does not read as a repeating phrase. */
const TEXTURE_SECONDS = 10;
const TEXTURE_FADE_S = 0.4;
/** RMS after shaping, so a darker or brighter curve does not change loudness. */
const TEXTURE_RMS = 0.2;

export type SchedulerHealth = {
  /** A timer is registered. A discarded browser timer can still look active until `wake`. */
  active: boolean;
  /** Audio-clock time of the next 16th to commit. Null while stopped. */
  nextTime: number | null;
  step: number | null;
  /** `currentTime` captured on the last tick. */
  lastTickTime: number | null;
  /** Wall time of the last tick, for spotting a timer that stopped firing. */
  lastTickWall: number | null;
  /** Latest catch-up that skipped a noticeable stretch or restored a sustain, if any. */
  anomaly: SchedulerCatchup | null;
  anomalySerial: number;
};

export type SchedulerCatchup = {
  skipped: number;
  /** 16ths committed after the cursor landed. Not the skipped ones. */
  scheduled: number;
  /** Note callbacks inside that lookahead window. Percussion is not replayed from the gap. */
  scheduledEvents: number;
  rewound: boolean;
  /** Sustains recreated from now through the time they still had left. */
  resumed: { bass: number; chords: number; lead: number };
  /** Step index before the jump. */
  fromStep: number | null;
  /** Step index after the jump, the next 16th to play. */
  step: number | null;
  /** Section that owns the landed step. */
  section: string | null;
  now: number | null;
  /** Audio time of the landed step. */
  cursor: number | null;
};

export type LayerReport = {
  /** Looping bed started with the piece. It does not wait on the 25 ms timer. */
  texture: "active" | "off";
  /** Wet send after section scaling. The return stays connected for the life of the graph. */
  reverbSend: number;
  buses: {
    out: number;
    kick: number;
    snare: number;
    hats: number;
    bass: number;
    chords: number;
    lead: number;
  };
  /** Score says this layer should be inside a note at the clock position. */
  expected: { bass: boolean; chords: boolean; lead: boolean };
  /** A note node was started and its written end is still ahead. */
  sounding: { bass: boolean; chords: boolean; lead: boolean };
  /** Audio time of the last committed or restored event. */
  last: {
    kick: number | null;
    snare: number | null;
    hats: number | null;
    drums: number | null;
    bass: number | null;
    chords: number | null;
    lead: number | null;
  };
};

export type MusicEngine = {
  /** Stops anything playing, then loops `composition`. `fromStep` is a 16th index, 0 = the intro. */
  play: (composition: Composition, fromStep?: number) => void;
  stop: () => void;
  /** Restart the timer and catch the cursor up. Does not restart the piece. */
  wake: () => SchedulerCatchup;
  /**
   * Development helper. Moves the cursor `seconds` behind the audio clock and
   * runs one tick, so a late timer can be tested without waiting.
   */
  debugStall: (seconds: number) => SchedulerCatchup;
  health: () => SchedulerHealth;
  /** Expected, sounding, and last-event times. Development snapshot; not a per-tick log. */
  layers: () => LayerReport;
  /**
   * Called after a catch-up jump so persistent fades outside the engine
   * (music, output, AI buses) can snap if their wall-clock end has passed.
   */
  setRecoveryListener: (listener: (() => void) | null) => void;
  dispose: () => void;
};

const idleCatch = (): SchedulerCatchup => ({
  skipped: 0,
  scheduled: 0,
  scheduledEvents: 0,
  rewound: false,
  resumed: { bass: 0, chords: 0, lead: 0 },
  fromStep: null,
  step: null,
  section: null,
  now: null,
  cursor: null,
});

/**
 * Fractional 16th position of `now`.
 * A cursor sitting a little ahead of the clock reports the 16th still sounding.
 * A cursor left behind by a stalled timer reports where the clock has moved to.
 */
export function scorePosition(
  cursorStep: number,
  nextTime: number,
  now: number,
  sixteenth: number,
  piece: number,
) {
  if (!(sixteenth > 0) || piece <= 0 || !Number.isFinite(now) || !Number.isFinite(nextTime)) {
    return 0;
  }
  const pos = cursorStep + (now - nextTime) / sixteenth;
  return ((pos % piece) + piece) % piece;
}

/** 16ths since this note's attack, wrapping once so a hold across the loop still matches. */
export function noteAge(noteStep: number, position: number, piece: number) {
  let age = position - noteStep;
  if (age < 0) age += piece;
  return age;
}

/**
 * Seconds left on a sustained note whose attack was never committed.
 * Returns null when the voice was already scheduled, the note is over,
 * or the attack is the step the lookahead is about to play.
 * Drums are not passed here: missed hits stay missed.
 */
export function missedSustain(
  noteStep: number,
  noteLength: number,
  cursorStep: number,
  nextTime: number,
  now: number,
  gapStart: number,
  sixteenth: number,
  piece: number,
) {
  if (!(noteLength > 0) || !(sixteenth > 0) || piece <= 0) {
    return null;
  }
  const age = noteAge(noteStep, scorePosition(cursorStep, nextTime, now, sixteenth, piece), piece);
  if (age < 0.001 || age >= noteLength) {
    return null;
  }
  const attackAt = now - age * sixteenth;
  // The tick that stalled had already handed this attack to the audio thread.
  if (attackAt < gapStart - 0.001) {
    return null;
  }
  const remaining = (noteLength - age) * sixteenth;
  if (remaining < 0.05) {
    return null;
  }
  return remaining;
}

/**
 * Jump the scheduler cursor to the audio clock without walking every missed 16th.
 * A clock that moved backward snaps the cursor to now and keeps the current step.
 */
export function catchUpCursor(
  nextTime: number,
  step: number,
  steps: number,
  now: number,
  sixteenth: number,
) {
  if (!(sixteenth > 0) || steps <= 0 || !Number.isFinite(now) || !Number.isFinite(nextTime)) {
    return { nextTime: Number.isFinite(now) ? now : 0, step: 0, skipped: 0, rewound: false };
  }
  if (nextTime > now + 0.75) {
    return { nextTime: now, step, skipped: 0, rewound: true };
  }
  if (nextTime >= now) {
    return { nextTime, step, skipped: 0, rewound: false };
  }
  const skipped = Math.ceil((now - nextTime) / sixteenth - 1e-8);
  const time = nextTime + skipped * sixteenth;
  const nextStep = (((step + skipped) % steps) + steps) % steps;
  return { nextTime: time, step: nextStep, skipped, rewound: false };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Tone of the bed from the profile already on the composition.
 * Higher brightness opens it. Higher softness keeps it smooth and slightly airy.
 * Lower softness lets a little upper-mid grain through.
 */
function textureCharacter(brightness: number, softness: number) {
  const b = clamp01(brightness);
  const s = clamp01(softness);
  // Squaring brightness spreads the darker worlds apart from the brighter ones.
  const open = b * b;
  const cutoff = 1800 + open * 14000 + s * s * 1400;
  return {
    bodyHz: 650 + open * 1600,
    // How much of the band between the body and the cutoff is allowed in.
    // Softness favors a little air. Less softness, with brightness, favors grain.
    colorMix: s * s * 0.12 + (1 - s) * open * 1.1,
    cutoff,
    width: 0.04 + (1 - s) * 0.025,
  };
}

function textureSeed(seed: number, brightness: number, softness: number) {
  const b = Math.round(clamp01(brightness) * 1000) + 1;
  const s = Math.round(clamp01(softness) * 1000) + 1;
  return (seed ^ 0xa3c59ac3 ^ Math.imul(b, 0x6c078965) ^ Math.imul(s, 0x4c691b3e)) >>> 0;
}

/** Very slow filter and level drift. Both periods sit far below a musical pulse. */
export function textureMotion(seed: number) {
  const rng = createRng((seed ^ 0x7f4a7c15) >>> 0);
  return {
    filterRate: 0.022 + rng.next() * 0.018,
    gainRate: 0.013 + rng.next() * 0.012,
  };
}

/**
 * One reusable stereo bed. The extra tail is blended into the start so the
 * loop point continues the waveform instead of dipping to silence.
 */
export function createTextureBed(
  context: BaseAudioContext,
  seed: number,
  brightness: number,
  softness: number,
) {
  const tone = textureCharacter(brightness, softness);
  const sr = context.sampleRate;
  // The bed is dull by design, so it is shaped at half rate and expanded after.
  const lowRate = Math.max(1, Math.floor(sr / 2));
  const fade = Math.max(1, Math.floor(lowRate * TEXTURE_FADE_S));
  const lowLength = Math.max(fade + 1, Math.floor(lowRate * TEXTURE_SECONDS));
  const total = lowLength + fade;
  const rng = createRng(textureSeed(seed, brightness, softness));
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const lp = (hz: number) => 1 - Math.exp((-2 * Math.PI * hz) / lowRate);
  const bodyA = lp(tone.bodyHz);
  const colorA = lp(tone.cutoff);
  const rumbleA = Math.exp((-2 * Math.PI * 70) / lowRate);
  let body = 0;
  let color = 0;
  let side = 0;
  let high = 0;
  let prev = 0;
  const settle = Math.floor(lowRate * 0.05);
  for (let i = 0; i < settle + total; i += 1) {
    const x = rng.next() * 2 - 1;
    const n = rng.next() * 2 - 1;
    body += bodyA * (x - body);
    color += colorA * (x - color);
    side += bodyA * (n - side);
    const center = body + (color - body) * tone.colorMix;
    high = rumbleA * (high + center - prev);
    prev = center;
    if (i < settle) {
      continue;
    }
    const index = i - settle;
    left[index] = high + side * tone.width;
    right[index] = high - side * tone.width;
  }

  const lowL = new Float32Array(lowLength);
  const lowR = new Float32Array(lowLength);
  lowL.set(left.subarray(0, lowLength));
  lowR.set(right.subarray(0, lowLength));
  for (let i = 0; i < fade; i += 1) {
    const t = i / fade;
    const fadeIn = Math.sin(t * Math.PI * 0.5);
    const fadeOut = Math.cos(t * Math.PI * 0.5);
    lowL[i] = left[i] * fadeIn + left[lowLength + i] * fadeOut;
    lowR[i] = right[i] * fadeIn + right[lowLength + i] * fadeOut;
  }
  removeDc(lowL);
  removeDc(lowR);
  normalizeStereo(lowL, lowR);

  const length = lowLength * 2;
  const buffer = context.createBuffer(2, length, sr);
  const outL = buffer.getChannelData(0);
  const outR = buffer.getChannelData(1);
  for (let i = 0; i < length; i += 1) {
    const pos = (i * lowLength) / length;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const i1 = i0 + 1 < lowLength ? i0 + 1 : 0;
    const keep = 1 - frac;
    outL[i] = lowL[i0] * keep + lowL[i1] * frac;
    outR[i] = lowR[i0] * keep + lowR[i1] * frac;
  }
  return buffer;
}

function removeDc(data: Float32Array) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    sum += data[i];
  }
  const mean = sum / data.length;
  for (let i = 0; i < data.length; i += 1) {
    data[i] -= mean;
  }
}

function normalizeStereo(left: Float32Array, right: Float32Array) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < left.length; i += 1) {
    sum += left[i] * left[i] + right[i] * right[i];
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const rms = Math.sqrt(sum / (left.length * 2));
  let g = rms > 1e-8 ? TEXTURE_RMS / rms : 0;
  if (peak * g > 0.8) {
    g = 0.8 / peak;
  }
  for (let i = 0; i < left.length; i += 1) {
    left[i] *= g;
    right[i] *= g;
  }
}

/**
 * One stable tail for a decay/damping pair. The start is centered and brighter;
 * the late tail is wider and darker, with a fast body plus a slower fade.
 */
function createImpulse(context: BaseAudioContext, seconds: number, damping: number) {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const damp = Math.min(1, Math.max(0, damping));
  const rng = createRng(((Math.round(seconds * 100) << 10) ^ Math.round(damp * 1000) ^ 0x51ed3) >>> 0);
  const startA = 0.34 - damp * 0.16;
  const endA = 0.07 + (1 - damp) * 0.08;
  let shared = 0;
  let leftN = 0;
  let rightN = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / context.sampleRate;
    const a = startA + (endA - startA) * (i / length);
    shared += a * (rng.next() * 2 - 1 - shared);
    leftN += a * (rng.next() * 2 - 1 - leftN);
    rightN += a * (rng.next() * 2 - 1 - rightN);
    const onset = Math.min(1, t / 0.025);
    const fast = Math.exp(-t / Math.max(0.04, seconds * 0.08));
    const slow = Math.exp(-t / Math.max(0.12, seconds / 5.5));
    const end = Math.min(1, Math.max(0, (seconds - t) / 0.06));
    const contour = onset * (0.7 * fast + 0.55 * slow) * end;
    const blend = Math.min(1, t / Math.max(0.25, seconds * 0.45));
    const common = 1 - blend * 0.72;
    left[i] = (shared * common + leftN * blend) * contour;
    right[i] = (shared * common + rightN * blend) * contour;
  }
  return buffer;
}

/** Quiet early taps, kept inside 10–80 ms so they read as space rather than echoes. */
const EARLY_TAPS = [
  { l: 0.013, r: 0.017, g: 0.16 },
  { l: 0.024, r: 0.029, g: 0.1 },
  { l: 0.037, r: 0.032, g: 0.06 },
  { l: 0.054, r: 0.067, g: 0.035 },
] as const;

/** Gentle tanh curve: rounds off peaks, near-linear at normal levels. */
function createSoftClip(amount: number) {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

/** Peak delay-time swing (s) at tape = 1: ≈ 5 cents of wow, ≈ 1.3 cents of flutter. */
const WOW_DEPTH_S = 0.0009;
const FLUTTER_DEPTH_S = 0.00002;
const TAPE_BASE_DELAY_S = 0.012;

/**
 * drums ────────────────────────────────┐
 * hats → per-hit pan ───────────────────┤
 * bass sine ────────────────────────────┐
 * bass octave → light clip ─────────────┴→ low-pass → soft clip ┤
 * keys → low-pass → low-shelf → soft clip ┤                     ├→ tone → tape → high-pass → compressor → out
 * lead → low-pass → per-note pan ───────┤   reverb → trim ──────┘
 * texture (seeded bed) ────────────────┘
 *        reverb: send → pre-delay → early taps + darker tail → high-pass → trim
 */
type TextureMotion = {
  filterOsc: OscillatorNode;
  filterDepth: GainNode;
  gainOsc: OscillatorNode;
  gainDepth: GainNode;
};

export function createMusicEngine(context: AudioContext, destination: AudioNode): MusicEngine {
  const node = <T extends AudioNode>(create: () => T, setup?: (n: T) => void) => {
    const n = create();
    setup?.(n);
    return n;
  };
  const gain = (value: number) => node(() => context.createGain(), (g) => (g.gain.value = value));
  const lowpass = (frequency: number) =>
    node(() => context.createBiquadFilter(), (f) => {
      f.type = "lowpass";
      f.frequency.value = frequency;
      f.Q.value = 0.5;
    });
  const clip = (amount: number) =>
    node(() => context.createWaveShaper(), (w) => {
      w.curve = createSoftClip(amount);
      w.oversample = "2x";
    });

  const out = gain(0);
  const glue = node(() => context.createDynamicsCompressor(), (c) => {
    c.threshold.value = -12;
    c.knee.value = 24;
    c.ratio.value = 1.5;
    c.attack.value = 0.02;
    c.release.value = 0.35;
  });
  const mud = node(() => context.createBiquadFilter(), (f) => {
    f.type = "highpass";
    f.frequency.value = 38;
    f.Q.value = 0.7;
  });
  const tone = lowpass(6000);
  const mix = gain(0.7);
  const preDelay = node(() => context.createDelay(0.1), (d) => {
    d.delayTime.value = 0;
    d.channelCount = 2;
    d.channelCountMode = "explicit";
    d.channelInterpretation = "speakers";
  });
  const reverb = node(() => context.createConvolver());
  const reverbDamp = lowpass(4000);
  const reverbSend = gain(0.3);
  const earlySplit = node(() => context.createChannelSplitter(2));
  const earlyMerge = node(() => context.createChannelMerger(2));
  const earlyLow = lowpass(4200);
  const earlyGain = gain(0.24);
  const wetHigh = node(() => context.createBiquadFilter(), (f) => {
    f.type = "highpass";
    f.frequency.value = 200;
    f.Q.value = 0.7;
  });
  // The dry bus is already at 0.7. The return used to skip that fader, so tails sat about 3 dB hot.
  const wetTrim = gain(0.7);
  const earlyTaps = EARLY_TAPS.map((tap) => {
    const l = node(() => context.createDelay(0.1), (d) => (d.delayTime.value = tap.l));
    const r = node(() => context.createDelay(0.1), (d) => (d.delayTime.value = tap.r));
    const gl = gain(tap.g);
    const gr = gain(tap.g);
    earlySplit.connect(l, 0);
    earlySplit.connect(r, 1);
    l.connect(gl);
    r.connect(gr);
    gl.connect(earlyMerge, 0, 0);
    gr.connect(earlyMerge, 0, 1);
    return { l, r, gl, gr };
  });
  const kickBus = gain(0.62);
  const snareBus = gain(0.62);
  const hatBus = gain(0.62);
  const kickSend = gain(0.04);
  const snareSend = gain(0.09);
  const hatSend = gain(0.018);
  const bassFilter = lowpass(520);
  const bassDrive = gain(1.3);
  const bassClip = clip(1.12);
  const bassTrim = gain(1 / 1.3);
  const bassLevel = gain(0.85);
  const bassHarmonicDrive = gain(1.75);
  const bassHarmonicClip = clip(1.5);
  const bassHarmonicTrim = gain(1 / 1.75);
  const keysFilter = lowpass(2400);
  const keysShelf = node(() => context.createBiquadFilter(), (f) => {
    f.type = "lowshelf";
    f.frequency.value = 320;
    f.gain.value = -2.4;
    f.Q.value = 0.7;
  });
  const keysDrive = gain(1.6);
  const keysClip = clip(1.25);
  const keysTrim = gain(1 / 1.6);
  const leadFilter = lowpass(3200);
  const leadPan = gain(1.26);

  const textureFilter = node(() => context.createBiquadFilter(), (f) => {
    f.type = "lowpass";
    f.frequency.value = 3600;
    f.Q.value = 0.5;
  });
  const textureGain = gain(0);
  let textureSource: AudioBufferSourceNode | null = null;
  let textureBuffer: AudioBuffer | null = null;
  let textureKey = "";
  let textureMotionNodes: TextureMotion | null = null;

  // Tape: the whole mix runs through a short delay whose time is wobbled by two slow LFOs.
  const tape = node(() => context.createDelay(0.05), (d) => (d.delayTime.value = TAPE_BASE_DELAY_S));
  const wow = node(() => context.createOscillator(), (o) => (o.frequency.value = 0.5));
  const flutter = node(() => context.createOscillator(), (o) => (o.frequency.value = 6));
  const wowDepth = gain(0);
  const flutterDepth = gain(0);
  wow.connect(wowDepth);
  flutter.connect(flutterDepth);
  wowDepth.connect(tape.delayTime);
  flutterDepth.connect(tape.delayTime);
  wow.start();
  flutter.start();

  kickBus.connect(mix);
  snareBus.connect(mix);
  hatBus.connect(mix);
  kickBus.connect(kickSend);
  snareBus.connect(snareSend);
  hatBus.connect(hatSend);
  kickSend.connect(reverbSend);
  snareSend.connect(reverbSend);
  hatSend.connect(reverbSend);
  bassFilter.connect(bassDrive);
  bassDrive.connect(bassClip);
  bassClip.connect(bassTrim);
  bassTrim.connect(bassLevel);
  bassLevel.connect(mix);
  bassHarmonicDrive.connect(bassHarmonicClip);
  bassHarmonicClip.connect(bassHarmonicTrim);
  bassHarmonicTrim.connect(bassFilter);
  keysFilter.connect(keysShelf);
  keysShelf.connect(keysDrive);
  keysDrive.connect(keysClip);
  keysClip.connect(keysTrim);
  keysTrim.connect(mix);
  keysTrim.connect(reverbSend);
  leadFilter.connect(leadPan);
  leadPan.connect(mix);
  leadPan.connect(reverbSend);
  reverbSend.connect(preDelay);
  preDelay.connect(reverb);
  preDelay.connect(earlySplit);
  earlyMerge.connect(earlyLow);
  earlyLow.connect(earlyGain);
  earlyGain.connect(wetHigh);
  reverb.connect(reverbDamp);
  reverbDamp.connect(wetHigh);
  wetHigh.connect(wetTrim);
  wetTrim.connect(tape);
  textureFilter.connect(textureGain);
  textureGain.connect(mix);
  mix.connect(tone);
  tone.connect(tape);
  tape.connect(mud);
  mud.connect(glue);
  glue.connect(out);
  out.connect(destination);

  const active = new Set<AudioScheduledSourceNode>();
  const register: RegisterSource = (source, ...chain) => {
    active.add(source);
    source.onended = () => {
      active.delete(source);
      source.disconnect();
      for (const n of chain) {
        n.disconnect();
      }
    };
  };

  const instruments = createInstruments(
    context,
    {
      drums: kickBus,
      snare: snareBus,
      hats: hatBus,
      bass: bassFilter,
      bassHarmonic: bassHarmonicDrive,
      keys: keysFilter,
      lead: leadFilter,
    },
    register,
  );

  let timer = 0;
  let composition: Composition | null = null;
  /** Per-16th-step note callbacks for the current loop, built once per composition. */
  let slots: ((when: number) => void)[][] = [];
  /** Chords, bass, and lead only. Drums stay in `slots` and are never restored. */
  let holds: {
    layer: "bass" | "chords" | "lead";
    step: number;
    length: number;
    play: (when: number, seconds: number) => void;
  }[] = [];
  let step = 0;
  let nextTime = 0;
  let lastTickTime: number | null = null;
  let lastTickWall: number | null = null;
  let anomaly: SchedulerHealth["anomaly"] = null;
  let anomalySerial = 0;
  let catchListener: (() => void) | null = null;
  /** Wall-clock moment the engine fade to 1 should already have finished. */
  let outSettleAt = 0;
  /** Wall-clock moment the texture fade should already have finished. */
  let textureSettleAt = 0;
  let textureLevel = 0;
  let textureCutoff = 3600;
  const lastAt: Record<"kick" | "snare" | "hats" | "bass" | "chords" | "lead", number | null> = {
    kick: null,
    snare: null,
    hats: null,
    bass: null,
    chords: null,
    lead: null,
  };
  const liveUntil = { bass: 0, chords: 0, lead: 0 };

  const markDrum = (layer: "kick" | "snare" | "hats", when: number) => {
    lastAt[layer] = when;
  };

  const markSustain = (layer: "bass" | "chords" | "lead", when: number, seconds: number) => {
    lastAt[layer] = when;
    liveUntil[layer] = Math.max(liveUntil[layer], when + seconds);
  };

  const resetLayers = () => {
    holds = [];
    lastAt.kick = null;
    lastAt.snare = null;
    lastAt.hats = null;
    lastAt.bass = null;
    lastAt.chords = null;
    lastAt.lead = null;
    liveUntil.bass = 0;
    liveUntil.chords = 0;
    liveUntil.lead = 0;
  };

  /**
   * Snaps bed levels whose fade end is already in the past.
   * Note envelopes are left alone. Runs once per fade, not on every tick.
   */
  const settleBeds = (now: number) => {
    const wall = performance.now();
    if (composition && outSettleAt > 0 && wall >= outSettleAt) {
      out.gain.cancelScheduledValues(now);
      out.gain.setValueAtTime(1, now);
      outSettleAt = 0;
    }
    if (textureSource && textureSettleAt > 0 && wall >= textureSettleAt) {
      textureGain.gain.cancelScheduledValues(now);
      textureGain.gain.setValueAtTime(textureLevel, now);
      textureFilter.frequency.cancelScheduledValues(now);
      textureFilter.frequency.setValueAtTime(textureCutoff, now);
      const motion = textureMotionNodes;
      if (motion) {
        motion.gainDepth.gain.cancelScheduledValues(now);
        motion.gainDepth.gain.setValueAtTime(textureLevel * 0.03, now);
      }
      textureSettleAt = 0;
    }
  };
  let impulseKey = "";

  const ensureImpulse = (seconds: number, damping: number) => {
    const rounded = Math.round(Math.min(4.5, Math.max(0.4, seconds)) * 100) / 100;
    const damp = Math.min(1, Math.max(0, damping));
    const key = `${rounded}:${Math.round(damp * 1000)}`;
    if (key === impulseKey) {
      return;
    }
    impulseKey = key;
    reverb.buffer = createImpulse(context, rounded, damp);
  };

  const ensureTexture = (seed: number, brightness: number, softness: number) => {
    const key = `${seed >>> 0}:${Math.round(clamp01(brightness) * 1000)}:${Math.round(clamp01(softness) * 1000)}:${context.sampleRate}`;
    if (key === textureKey && textureBuffer) {
      return textureBuffer;
    }
    textureKey = key;
    textureBuffer = createTextureBed(context, seed, brightness, softness);
    return textureBuffer;
  };

  /** Drops the slow drift immediately so a new piece does not inherit it. */
  const stopMotion = (when: number) => {
    const motion = textureMotionNodes;
    textureMotionNodes = null;
    if (!motion) {
      return;
    }
    const nodes = [motion.filterOsc, motion.filterDepth, motion.gainOsc, motion.gainDepth];
    motion.filterOsc.onended = () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          // already disconnected
        }
      }
    };
    try {
      motion.filterDepth.disconnect();
      motion.gainDepth.disconnect();
    } catch {
      // already disconnected
    }
    for (const osc of [motion.filterOsc, motion.gainOsc]) {
      try {
        osc.stop(when);
      } catch {
        // already stopped
      }
    }
  };

  /** Fades the bed out and stops its loop. A following start replaces the ramp. */
  const haltTexture = (when: number) => {
    stopMotion(when);
    textureGain.gain.cancelScheduledValues(when);
    textureGain.gain.setValueAtTime(textureGain.gain.value, when);
    textureGain.gain.linearRampToValueAtTime(0, when + STOP_FADE_S);
    const source = textureSource;
    textureSource = null;
    if (!source) {
      return;
    }
    source.onended = () => {
      try {
        source.disconnect();
      } catch {
        // already disconnected
      }
    };
    try {
      source.stop(when + STOP_FADE_S + 0.01);
    } catch {
      // already stopped
    }
  };

  const startMotion = (when: number, seed: number, cutoff: number, level: number) => {
    stopMotion(when);
    const motion = textureMotion(seed);
    const filterOsc = context.createOscillator();
    const filterDepth = gain(cutoff * 0.045);
    const gainOsc = context.createOscillator();
    const gainDepth = gain(0);
    filterOsc.frequency.value = motion.filterRate;
    gainOsc.frequency.value = motion.gainRate;
    filterOsc.connect(filterDepth);
    filterDepth.connect(textureFilter.frequency);
    gainOsc.connect(gainDepth);
    gainDepth.connect(textureGain.gain);
    gainDepth.gain.setValueAtTime(0, when);
    gainDepth.gain.linearRampToValueAtTime(level * 0.03, when + 0.45);
    filterOsc.start(when);
    gainOsc.start(when);
    textureMotionNodes = { filterOsc, filterDepth, gainOsc, gainDepth };
  };

  const startTexture = (
    amount: number,
    when: number,
    seed: number,
    brightness: number,
    softness: number,
  ) => {
    textureGain.gain.cancelScheduledValues(when);
    textureGain.gain.setValueAtTime(0, when);
    const level = clamp01(amount) * TEXTURE_PEAK;
    if (level < 0.00001) {
      stopMotion(when);
      return;
    }
    const tone = textureCharacter(brightness, softness);
    // Sit above the curve already baked into the buffer so the two filters do not stack.
    const openCutoff = tone.cutoff * 1.25;
    textureFilter.frequency.cancelScheduledValues(when);
    textureFilter.frequency.setValueAtTime(textureFilter.frequency.value, when);
    textureFilter.frequency.setTargetAtTime(openCutoff, when, 0.2);
    textureGain.gain.linearRampToValueAtTime(level, when + 0.45);
    textureLevel = level;
    textureCutoff = openCutoff;
    textureSettleAt = performance.now() + 450;
    const source = context.createBufferSource();
    source.buffer = ensureTexture(seed, brightness, softness);
    source.loop = true;
    source.connect(textureFilter);
    source.start(when);
    textureSource = source;
    startMotion(when, seed, openCutoff, level);
  };

  /** Filter/reverb targets for the composition's base `space`, scaled per section. */
  let base = { tone: 6000, keys: 2400, wet: 0.3 };
  const applySection = (brightness: number, wet: number, when: number, glide: number) => {
    for (const [param, value] of [
      [tone.frequency, base.tone * brightness],
      [keysFilter.frequency, base.keys * brightness],
      [reverbSend.gain, base.wet * wet],
    ] as const) {
      if (glide > 0) {
        param.setTargetAtTime(value, when, glide);
      } else {
        param.cancelScheduledValues(when);
        param.setValueAtTime(value, when);
      }
    }
  };

  const index = (c: Composition, sixteenth: number) => {
    const table: ((when: number) => void)[][] = Array.from({ length: c.steps }, () => []);
    holds = [];
    const at = (s: number, fn: (when: number) => void) => table[s % c.steps].push(fn);
    for (const section of c.sections) {
      // Sections glide in over about a bar rather than switching abruptly.
      at(section.step, (when) => applySection(section.tone, section.wet, when, sixteenth * 4));
    }
    const kickTone = createRng(c.seed ^ 0x85ebca6b);
    const snareTone = createRng(c.seed ^ 0xc2b2ae35);
    const hatTone = createRng(c.seed ^ 0x27d4eb2f);
    for (const hit of c.drums) {
      if (hit.kind === "kick") {
        const color = kickTone.next();
        at(hit.step, (when) => {
          if (hit.velocity > 0) markDrum("kick", when);
          instruments.kick(when + hit.nudge, hit.velocity, color);
        });
      } else if (hit.kind === "snare") {
        const color = snareTone.next();
        at(hit.step, (when) => {
          if (hit.velocity > 0) markDrum("snare", when);
          instruments.snare(when + hit.nudge, hit.velocity, color);
        });
      } else {
        const color = hatTone.next();
        at(hit.step, (when) => {
          if (hit.velocity > 0) markDrum("hats", when);
          instruments[hit.kind](when + hit.nudge, hit.velocity, color);
        });
      }
    }
    const tone = createRng(c.seed ^ 0xb5297a4d);
    for (const n of c.bass) {
      const color = tone.next();
      const duration = n.length * sixteenth;
      if (n.velocity > 0 && n.length > 0) {
        holds.push({
          layer: "bass",
          step: n.step % c.steps,
          length: n.length,
          play(when, remain) {
            markSustain("bass", when, remain);
            instruments.bass(when, remain, n.midi, n.velocity, color);
          },
        });
      }
      at(n.step, (when) => {
        if (n.velocity > 0) markSustain("bass", when, duration);
        instruments.bass(when + n.nudge, duration, n.midi, n.velocity, color);
      });
    }
    for (const chord of c.chords) {
      const duration = chord.length * sixteenth;
      if (chord.velocity > 0 && chord.length > 0) {
        holds.push({
          layer: "chords",
          step: chord.step % c.steps,
          length: chord.length,
          play(when, remain) {
            markSustain("chords", when, remain);
            instruments.keys(when, remain, chord);
          },
        });
      }
      at(chord.step, (when) => {
        if (chord.velocity > 0) markSustain("chords", when, duration);
        instruments.keys(when + chord.nudge, duration, chord);
      });
    }
    for (const n of c.melody) {
      const color = tone.next();
      const duration = n.length * sixteenth;
      if (n.velocity > 0 && n.length > 0) {
        holds.push({
          layer: "lead",
          step: n.step % c.steps,
          length: n.length,
          play(when, remain) {
            markSustain("lead", when, remain);
            instruments.lead(when, remain, n.midi, n.velocity, color);
          },
        });
      }
      at(n.step, (when) => {
        if (n.velocity > 0) markSustain("lead", when, duration);
        instruments.lead(when + n.nudge, duration, n.midi, n.velocity, color);
      });
    }
    return table;
  };

  const tick = (): SchedulerCatchup => {
    if (!composition) {
      return idleCatch();
    }
    const now = context.currentTime;
    settleBeds(now);
    const sixteenth = 60 / composition.bpm / 4;
    const fromStep = step;
    const gapStart = nextTime;
    const caught = catchUpCursor(nextTime, step, composition.steps, now, sixteenth);
    nextTime = caught.nextTime;
    step = caught.step;
    const resumed = { bass: 0, chords: 0, lead: 0 };
    let sectionName: string | null = null;
    if (caught.skipped > 0) {
      const section = [...composition.sections].reverse().find((item) => item.step <= step) ?? composition.sections[0];
      sectionName = section?.kind ?? null;
      // Tone, keys filter, and reverb send. Density and transitions live in the event list.
      applySection(section?.tone ?? 1, section?.wet ?? 1, now, 0);
      const upcoming = new Set<number>();
      let scanTime = nextTime;
      let scanStep = step;
      while (scanTime < now + LOOKAHEAD_S) {
        const when = scanStep % 2 === 1 ? scanTime + composition.swing * sixteenth : scanTime;
        if (when >= now - 0.05) {
          upcoming.add(scanStep);
        }
        scanTime += sixteenth;
        scanStep = (scanStep + 1) % composition.steps;
      }
      for (const hold of holds) {
        // The lookahead is about to play this attack itself.
        if (upcoming.has(hold.step)) {
          continue;
        }
        const remaining = missedSustain(
          hold.step,
          hold.length,
          step,
          nextTime,
          now,
          gapStart,
          sixteenth,
          composition.steps,
        );
        if (remaining == null) {
          continue;
        }
        // Start at the clock, for the time the note still had. The missed attack is not replayed.
        hold.play(now, remaining);
        resumed[hold.layer] += 1;
      }
      catchListener?.();
    }
    const landedStep = step;
    const landedCursor = nextTime;
    let scheduled = 0;
    let scheduledEvents = 0;
    while (nextTime < now + LOOKAHEAD_S) {
      const when = step % 2 === 1 ? nextTime + composition.swing * sixteenth : nextTime;
      // A 16th that is already late stays skipped. The lookahead only commits what is due now.
      if (when >= now - 0.05) {
        for (const play of slots[step] ?? []) {
          play(when);
          scheduledEvents += 1;
        }
        scheduled += 1;
      }
      nextTime += sixteenth;
      step = (step + 1) % composition.steps;
    }
    lastTickTime = now;
    lastTickWall = performance.now();
    const report: SchedulerCatchup = {
      skipped: caught.skipped,
      scheduled,
      scheduledEvents,
      rewound: caught.rewound,
      resumed,
      fromStep,
      step: landedStep,
      section: sectionName,
      now,
      cursor: landedCursor,
    };
    const restored = resumed.bass + resumed.chords + resumed.lead;
    if (caught.skipped >= 8 || caught.rewound || restored > 0) {
      anomalySerial += 1;
      anomaly = report;
    }
    return report;
  };

  /** One lookahead timer. The previous id is cleared before the new one is armed. */
  const armTimer = () => {
    window.clearInterval(timer);
    timer = window.setInterval(tick, TICK_MS);
  };

  const stop = () => {
    window.clearInterval(timer);
    timer = 0;
    composition = null;
    anomaly = null;
    outSettleAt = 0;
    textureSettleAt = 0;
    resetLayers();
    const now = context.currentTime;
    haltTexture(now);
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.linearRampToValueAtTime(0, now + STOP_FADE_S);
    for (const source of active) {
      try {
        source.stop(now + STOP_FADE_S + 0.01);
      } catch {
        // already stopped
      }
    }
  };

  return {
    play(next, fromStep = 0) {
      stop();
      ensureTexture(next.seed, next.space.brightness, next.space.softness);
      const now = context.currentTime;
      const { brightness, softness } = next.space;
      const { amount, decay, damping, preDelay: delay = 0 } = next.reverb;
      base = { tone: 1800 + brightness * 7000, keys: 900 + brightness * 3200, wet: 0.05 + amount * 0.55 };
      const damp = Math.min(1, Math.max(0, damping));
      ensureImpulse(decay, damp);
      preDelay.delayTime.setValueAtTime(Math.min(0.08, Math.max(0, delay)), now);
      const room = 0.84 + Math.min(1, decay / 4.5) * 0.38;
      earlyTaps.forEach((tap, i) => {
        tap.l.delayTime.setValueAtTime(Math.min(0.08, EARLY_TAPS[i].l * room), now);
        tap.r.delayTime.setValueAtTime(Math.min(0.08, EARLY_TAPS[i].r * room), now);
      });
      earlyLow.frequency.setValueAtTime(2800 + (1 - damp) * 2400, now);
      reverbDamp.frequency.setValueAtTime(2400 + (1 - damp) * 5000, now);
      const tune = (createRng(next.seed ^ 0x9e3779b9).next() - 0.5) * 12;
      instruments.setSound(next.sound, softness, tune, next.seed);
      leadFilter.frequency.setValueAtTime(1600 + brightness * 3600, now);
      wow.frequency.setValueAtTime(next.tape.wowRate, now);
      flutter.frequency.setValueAtTime(next.tape.flutterRate, now);
      wowDepth.gain.setValueAtTime(next.tape.depth * WOW_DEPTH_S, now);
      flutterDepth.gain.setValueAtTime(next.tape.depth * FLUTTER_DEPTH_S, now);
      startTexture(next.sound.textureAmount, now, next.seed, brightness, softness);

      const start = ((fromStep % next.steps) + next.steps) % next.steps;
      const section = [...next.sections].reverse().find((item) => item.step <= start) ?? next.sections[0];
      applySection(section?.tone ?? 1, section?.wet ?? 1, now, 0);

      composition = next;
      slots = index(next, 60 / next.bpm / 4);
      step = start;
      nextTime = now + START_DELAY_S;
      out.gain.setValueAtTime(0, now + STOP_FADE_S + 0.01);
      out.gain.linearRampToValueAtTime(1, now + START_DELAY_S - 0.01);
      outSettleAt = performance.now() + Math.max(0, START_DELAY_S - 0.01) * 1000;
      anomaly = null;
      tick();
      armTimer();
    },
    stop,
    wake() {
      if (!composition) {
        return idleCatch();
      }
      const caught = tick();
      armTimer();
      return caught;
    },
    debugStall(seconds: number) {
      if (!composition) {
        return idleCatch();
      }
      nextTime = context.currentTime - Math.max(0, seconds);
      const caught = tick();
      armTimer();
      return caught;
    },
    health: () => ({
      active: timer !== 0,
      nextTime: composition ? nextTime : null,
      step: composition ? step : null,
      lastTickTime,
      lastTickWall,
      anomaly,
      anomalySerial,
    }),
    layers() {
      const now = context.currentTime;
      const drumTimes = [lastAt.kick, lastAt.snare, lastAt.hats].filter((value): value is number => value != null);
      const expected = { bass: false, chords: false, lead: false };
      if (composition) {
        const sixteenth = 60 / composition.bpm / 4;
        const position = scorePosition(step, nextTime, now, sixteenth, composition.steps);
        for (const hold of holds) {
          const age = noteAge(hold.step, position, composition.steps);
          if (age > 0.001 && age < hold.length) {
            expected[hold.layer] = true;
          }
        }
      }
      return {
        texture: textureSource ? "active" : "off",
        reverbSend: reverbSend.gain.value,
        buses: {
          out: out.gain.value,
          kick: kickBus.gain.value,
          snare: snareBus.gain.value,
          hats: hatBus.gain.value,
          bass: bassLevel.gain.value,
          chords: keysTrim.gain.value,
          lead: leadPan.gain.value,
        },
        expected,
        sounding: {
          bass: liveUntil.bass > now,
          chords: liveUntil.chords > now,
          lead: liveUntil.lead > now,
        },
        last: {
          kick: lastAt.kick,
          snare: lastAt.snare,
          hats: lastAt.hats,
          drums: drumTimes.length > 0 ? Math.max(...drumTimes) : null,
          bass: lastAt.bass,
          chords: lastAt.chords,
          lead: lastAt.lead,
        },
      };
    },
    setRecoveryListener(listener) {
      catchListener = listener;
    },
    dispose() {
      stop();
      wow.stop();
      flutter.stop();
      for (const n of [
        out, glue, mud, tone, mix, preDelay, reverb, reverbDamp, reverbSend,
        earlySplit, earlyMerge, earlyLow, earlyGain, wetHigh, wetTrim,
        ...earlyTaps.flatMap((tap) => [tap.l, tap.r, tap.gl, tap.gr]),
        kickBus, snareBus, hatBus, kickSend, snareSend, hatSend,
        bassFilter, bassDrive, bassClip, bassTrim, bassLevel, bassHarmonicDrive, bassHarmonicClip, bassHarmonicTrim,
        keysFilter, keysShelf, keysDrive, keysClip, keysTrim,
        leadFilter, leadPan, textureFilter, textureGain, tape, wow, flutter, wowDepth, flutterDepth,
      ]) {
        n.disconnect();
      }
    },
  };
}
