import type { Composition } from "@/audio/music/composer";
import { createInstruments, type RegisterSource } from "@/audio/music/instruments";
import { createRng } from "@/audio/music/random";

/** How far ahead notes are committed to the AudioContext clock, and how often we top up. */
const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
const START_DELAY_S = 0.1;
const STOP_FADE_S = 0.04;
/** textureAmount 1 lands here: about -38 dB, still a background hiss. */
const TEXTURE_PEAK = 0.012;

export type MusicEngine = {
  /** Stops anything playing, then loops `composition`. `fromStep` is a 16th index, 0 = the intro. */
  play: (composition: Composition, fromStep?: number) => void;
  stop: () => void;
  dispose: () => void;
};

/** Flat noise with a short fade at the seam so a loop doesn't click. */
function createLoopNoise(context: BaseAudioContext, seconds: number) {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  const fade = Math.min(length >> 1, Math.floor(context.sampleRate * 0.03));
  for (let i = 0; i < fade; i += 1) {
    const g = i / fade;
    data[i] *= g;
    data[length - 1 - i] *= g;
  }
  return buffer;
}

function createImpulse(context: BaseAudioContext, seconds: number) {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i += 1) {
      low += 0.15 * (Math.random() * 2 - 1 - low);
      data[i] = low * (1 - i / length) ** 2.4;
    }
  }
  return buffer;
}

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
 * keys → low-pass → soft clip ──────────┤                       ├→ tape → high-pass → compressor → out
 * lead → low-pass → per-note pan ───────┤   reverb ─────────────┘
 * texture (looping noise) ──────────────┘
 *        reverb: send → pre-delay → convolver → damping
 */
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
  const preDelay = node(() => context.createDelay(0.1), (d) => (d.delayTime.value = 0));
  const reverb = node(() => context.createConvolver());
  const reverbDamp = lowpass(4000);
  const reverbSend = gain(0.3);
  const drums = gain(0.62);
  const hats = gain(1);
  const bassFilter = lowpass(520);
  const bassDrive = gain(1.3);
  const bassClip = clip(1.12);
  const bassTrim = gain(1 / 1.3);
  const bassHarmonicDrive = gain(1.75);
  const bassHarmonicClip = clip(1.5);
  const bassHarmonicTrim = gain(1 / 1.75);
  const keysFilter = lowpass(2400);
  const keysDrive = gain(1.6);
  const keysClip = clip(1.25);
  const keysTrim = gain(1 / 1.6);
  const leadFilter = lowpass(3200);
  const leadPan = gain(1);
  const drumSend = gain(0.12);

  const textureBuffer = createLoopNoise(context, 2);
  const textureFilter = node(() => context.createBiquadFilter(), (f) => {
    f.type = "bandpass";
    f.frequency.value = 1600;
    f.Q.value = 0.35;
  });
  const textureGain = gain(0);
  let textureSource: AudioBufferSourceNode | null = null;

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

  drums.connect(mix);
  hats.connect(drums);
  bassFilter.connect(bassDrive);
  bassDrive.connect(bassClip);
  bassClip.connect(bassTrim);
  bassTrim.connect(mix);
  bassHarmonicDrive.connect(bassHarmonicClip);
  bassHarmonicClip.connect(bassHarmonicTrim);
  bassHarmonicTrim.connect(bassFilter);
  keysFilter.connect(keysDrive);
  keysDrive.connect(keysClip);
  keysClip.connect(keysTrim);
  keysTrim.connect(mix);
  keysTrim.connect(reverbSend);
  leadFilter.connect(leadPan);
  leadPan.connect(mix);
  leadPan.connect(reverbSend);
  drums.connect(drumSend);
  drumSend.connect(reverbSend);
  reverbSend.connect(preDelay);
  preDelay.connect(reverb);
  reverb.connect(reverbDamp);
  reverbDamp.connect(tape);
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
    { drums, hats, bass: bassFilter, bassHarmonic: bassHarmonicDrive, keys: keysFilter, lead: leadFilter },
    register,
  );

  let timer = 0;
  let composition: Composition | null = null;
  /** Per-16th-step note callbacks for the current loop, built once per composition. */
  let slots: ((when: number) => void)[][] = [];
  let step = 0;
  let nextTime = 0;
  let impulseSeconds = -1;

  const ensureImpulse = (seconds: number) => {
    const rounded = Math.round(Math.min(4.5, Math.max(0.4, seconds)) * 100) / 100;
    if (rounded === impulseSeconds) {
      return;
    }
    impulseSeconds = rounded;
    reverb.buffer = createImpulse(context, rounded);
  };

  /** Fades the hiss out and stops its loop. A following start replaces the ramp. */
  const haltTexture = (when: number) => {
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

  const startTexture = (amount: number, when: number) => {
    textureGain.gain.cancelScheduledValues(when);
    textureGain.gain.setValueAtTime(0, when);
    const level = Math.min(1, Math.max(0, amount)) * TEXTURE_PEAK;
    if (level < 0.00001) {
      return;
    }
    textureGain.gain.linearRampToValueAtTime(level, when + 0.45);
    const source = context.createBufferSource();
    source.buffer = textureBuffer;
    source.loop = true;
    source.connect(textureFilter);
    source.start(when);
    textureSource = source;
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
    const at = (s: number, fn: (when: number) => void) => table[s % c.steps].push(fn);
    for (const section of c.sections) {
      // Sections glide in over about a bar rather than switching abruptly.
      at(section.step, (when) => applySection(section.tone, section.wet, when, sixteenth * 4));
    }
    for (const hit of c.drums) {
      at(hit.step, (when) => instruments[hit.kind](when + hit.nudge, hit.velocity));
    }
    const tone = createRng(c.seed ^ 0xb5297a4d);
    for (const n of c.bass) {
      const color = tone.next();
      at(n.step, (when) => instruments.bass(when + n.nudge, n.length * sixteenth, n.midi, n.velocity, color));
    }
    for (const chord of c.chords) {
      at(chord.step, (when) => instruments.keys(when + chord.nudge, chord.length * sixteenth, chord));
    }
    for (const n of c.melody) {
      const color = tone.next();
      at(n.step, (when) => instruments.lead(when + n.nudge, n.length * sixteenth, n.midi, n.velocity, color));
    }
    return table;
  };

  const tick = () => {
    if (!composition) {
      return;
    }
    const sixteenth = 60 / composition.bpm / 4;
    // If the timer stalled (e.g. a busy main thread), skip missed steps instead of bursting them.
    while (nextTime < context.currentTime) {
      nextTime += sixteenth;
      step = (step + 1) % composition.steps;
    }
    while (nextTime < context.currentTime + LOOKAHEAD_S) {
      const when = step % 2 === 1 ? nextTime + composition.swing * sixteenth : nextTime;
      for (const play of slots[step]) {
        play(when);
      }
      nextTime += sixteenth;
      step = (step + 1) % composition.steps;
    }
  };

  const stop = () => {
    window.clearInterval(timer);
    timer = 0;
    composition = null;
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
      const now = context.currentTime;
      const { brightness, softness } = next.space;
      const { amount, decay, damping, preDelay: delay = 0 } = next.reverb;
      base = { tone: 1800 + brightness * 7000, keys: 900 + brightness * 3200, wet: 0.05 + amount * 0.55 };
      ensureImpulse(decay);
      preDelay.delayTime.setValueAtTime(Math.min(0.08, Math.max(0, delay)), now);
      reverbDamp.frequency.setValueAtTime(1400 + (1 - Math.min(1, Math.max(0, damping))) * 5600, now);
      const tune = (createRng(next.seed ^ 0x9e3779b9).next() - 0.5) * 12;
      instruments.setSound(next.sound, softness, tune);
      leadFilter.frequency.setValueAtTime(1600 + brightness * 3600, now);
      wow.frequency.setValueAtTime(next.tape.wowRate, now);
      flutter.frequency.setValueAtTime(next.tape.flutterRate, now);
      wowDepth.gain.setValueAtTime(next.tape.depth * WOW_DEPTH_S, now);
      flutterDepth.gain.setValueAtTime(next.tape.depth * FLUTTER_DEPTH_S, now);
      startTexture(next.sound.textureAmount, now);

      const start = ((fromStep % next.steps) + next.steps) % next.steps;
      const section = [...next.sections].reverse().find((item) => item.step <= start) ?? next.sections[0];
      applySection(section?.tone ?? 1, section?.wet ?? 1, now, 0);

      composition = next;
      slots = index(next, 60 / next.bpm / 4);
      step = start;
      nextTime = now + START_DELAY_S;
      out.gain.setValueAtTime(0, now + STOP_FADE_S + 0.01);
      out.gain.linearRampToValueAtTime(1, now + START_DELAY_S - 0.01);
      tick();
      timer = window.setInterval(tick, TICK_MS);
    },
    stop,
    dispose() {
      stop();
      wow.stop();
      flutter.stop();
      for (const n of [
        out, glue, mud, tone, mix, preDelay, reverb, reverbDamp, reverbSend, drums, hats,
        bassFilter, bassDrive, bassClip, bassTrim, bassHarmonicDrive, bassHarmonicClip, bassHarmonicTrim,
        keysFilter, keysDrive, keysClip, keysTrim,
        leadFilter, leadPan, drumSend, textureFilter, textureGain, tape, wow, flutter, wowDepth, flutterDepth,
      ]) {
        n.disconnect();
      }
    },
  };
}
