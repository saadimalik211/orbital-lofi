/** Synthesized voices. Every note starts and ends at zero gain so nothing clicks. */

import type { MusicSound } from "@/worlds/types";

export type InstrumentBuses = {
  drums: AudioNode;
  hats: AudioNode;
  bass: AudioNode;
  keys: AudioNode;
  lead: AudioNode;
};

/** Called for every source so the engine can stop anything still sounding. */
export type RegisterSource = (source: AudioScheduledSourceNode, ...chain: AudioNode[]) => void;

export type KeysChord = {
  notes: readonly number[];
  delays: readonly number[];
  levels: readonly number[];
  release: number;
  velocity: number;
};

const midiToFreq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function createNoise(context: BaseAudioContext) {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/** Attack to `peak`, decay toward `peak * sustain`, release from `end`. Returns the stop time. */
function envelope(
  param: AudioParam,
  start: number,
  end: number,
  peak: number,
  { attack, decay, sustain, release }: { attack: number; decay: number; sustain: number; release: number },
) {
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak, start + attack);
  param.setTargetAtTime(peak * sustain, start + attack, decay);
  const releaseAt = Math.max(end, start + attack);
  param.setTargetAtTime(0, releaseAt, release / 4);
  return releaseAt + release;
}

export function createInstruments(
  context: AudioContext,
  buses: InstrumentBuses,
  register: RegisterSource,
) {
  const noise = createNoise(context);
  let noiseCursor = 0;
  /** 0 = snappy, 1 = slow soft attacks. Set per composition. */
  let softness = 0.5;
  let sound: MusicSound = {
    kickSoftness: 0.5,
    snareBrightness: 0.4,
    hatBrightness: 0.4,
    chordWarmth: 0.6,
    leadBrightness: 0.4,
    textureAmount: 0,
  };
  /** Seeded Hz offset for the snare's tonal layer. Same seed, same pitch. */
  let snareTune = 0;

  const noiseHit = (
    destination: AudioNode,
    when: number,
    filterType: BiquadFilterType,
    frequency: number,
    peak: number,
    decay: number,
    q = 0.7,
  ) => {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = noise;
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const stopAt = envelope(gain.gain, when, when + 0.003, peak, {
      attack: 0.0015,
      decay,
      sustain: 0,
      release: decay * 2,
    });
    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    noiseCursor = (noiseCursor + 0.037) % 0.5;
    source.start(when, noiseCursor);
    source.stop(stopAt + 0.02);
    register(source, filter, gain);
  };

  return {
    setSound(next: MusicSound, nextSoftness: number, tune: number) {
      sound = {
        kickSoftness: clamp01(next.kickSoftness),
        snareBrightness: clamp01(next.snareBrightness),
        hatBrightness: clamp01(next.hatBrightness),
        chordWarmth: clamp01(next.chordWarmth),
        leadBrightness: clamp01(next.leadBrightness),
        textureAmount: clamp01(next.textureAmount),
      };
      softness = clamp01(nextSoftness);
      snareTune = tune;
    },

    /**
     * Warm kick: a sine that falls quickly onto a low note, plus a very short
     * band-passed click. Softer profiles almost drop the click and keep the tail short.
     */
    kick(when: number, velocity: number) {
      const soft = sound.kickSoftness;
      const level = Math.min(1.15, Math.max(0, velocity));
      const body = context.createOscillator();
      const gain = context.createGain();
      body.type = "sine";
      const startHz = 72 + (1 - soft) * 48;
      body.frequency.setValueAtTime(startHz, when);
      body.frequency.exponentialRampToValueAtTime(44 + (1 - soft) * 8, when + 0.07 + soft * 0.04);
      const stopAt = envelope(gain.gain, when, when + 0.016, 0.46 * level * (0.85 + 0.15 * (1 - soft)), {
        attack: 0.003,
        decay: 0.06 + soft * 0.03,
        sustain: 0,
        release: 0.14 + soft * 0.06,
      });
      body.connect(gain);
      gain.connect(buses.drums);
      body.start(when);
      body.stop(stopAt + 0.02);
      register(body, gain);

      const click = 0.12 * level * (1 - soft * 0.88);
      if (click > 0.012) {
        noiseHit(buses.drums, when, "bandpass", 1400 + (1 - soft) * 900, click, 0.007 + (1 - soft) * 0.005, 0.6);
      }
    },

    /** Soft lofi snare: a dark noise body, a quieter low thump, and a short sine tone. */
    snare(when: number, velocity: number) {
      const bright = sound.snareBrightness;
      const level = Math.min(1.15, Math.max(0, velocity));
      noiseHit(buses.drums, when, "bandpass", 650 + bright * 1100, 0.24 * level, 0.04 + bright * 0.012, 0.65);
      noiseHit(buses.drums, when, "lowpass", 420, 0.07 * level, 0.028, 0.5);
      const tone = context.createOscillator();
      const gain = context.createGain();
      tone.type = "sine";
      tone.frequency.value = 168 + bright * 28 + snareTune;
      const stopAt = envelope(gain.gain, when, when + 0.008, 0.09 * level, {
        attack: 0.002,
        decay: 0.022,
        sustain: 0,
        release: 0.045,
      });
      tone.connect(gain);
      gain.connect(buses.drums);
      tone.start(when);
      tone.stop(stopAt + 0.02);
      register(tone, gain);
    },

    hat(when: number, velocity: number) {
      const bright = sound.hatBrightness;
      noiseHit(
        buses.hats,
        when,
        "bandpass",
        4000 + bright * 2600,
        0.1 * velocity,
        0.011 + (1 - bright) * 0.006,
        0.55,
      );
    },

    /** Same noise as the closed hat, held a little longer and tuned slightly lower. */
    openHat(when: number, velocity: number) {
      const bright = sound.hatBrightness;
      noiseHit(
        buses.hats,
        when,
        "bandpass",
        3400 + bright * 2000,
        0.08 * velocity,
        0.05 + bright * 0.02,
        0.45,
      );
    },

    bass(when: number, duration: number, midi: number, velocity: number) {
      const level = Math.min(1.15, Math.max(0, velocity));
      const sub = context.createOscillator();
      const body = context.createOscillator();
      const bodyGain = context.createGain();
      const gain = context.createGain();
      sub.type = "sine";
      body.type = "triangle";
      const freq = midiToFreq(midi);
      sub.frequency.value = freq;
      body.frequency.value = freq;
      bodyGain.gain.value = 0.14;
      const stopAt = envelope(gain.gain, when, when + duration, 0.32 * level, {
        attack: 0.012 + softness * 0.03,
        decay: 0.3,
        sustain: 0.72,
        release: 0.12,
      });
      sub.connect(gain);
      body.connect(bodyGain);
      bodyGain.connect(gain);
      gain.connect(buses.bass);
      sub.start(when);
      body.start(when);
      sub.stop(stopAt + 0.02);
      body.stop(stopAt + 0.02);
      register(sub, gain);
      register(body, bodyGain);
    },

    /**
     * Mellow electric keys. Each note is a sine plus a quiet detuned triangle;
     * cooler profiles add a faint octave harmonic. One low-pass per chord opens
     * on the attack and settles, and a tiny noise tick sells the strike.
     */
    keys(when: number, duration: number, chord: KeysChord) {
      const { notes, delays, levels, release, velocity } = chord;
      const warmth = sound.chordWarmth;
      const level = Math.min(1.15, Math.max(0, velocity));
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.6;
      const open = (2400 + 1600 * level) * (1.2 - warmth * 0.45) * (1 - softness * 0.2);
      filter.frequency.setValueAtTime(open, when);
      filter.frequency.setTargetAtTime(620 + (1 - warmth) * 700, when + 0.012, 0.16 + softness * 0.4);
      filter.connect(buses.keys);

      const tick = 0.035 * level * (1 - warmth * 0.75);
      if (tick > 0.008) {
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = noise;
        const stopAt = envelope(gain.gain, when, when + 0.002, tick, {
          attack: 0.0015,
          decay: 0.01,
          sustain: 0,
          release: 0.02,
        });
        source.connect(gain);
        gain.connect(filter);
        noiseCursor = (noiseCursor + 0.037) % 0.5;
        source.start(when, noiseCursor);
        source.stop(stopAt + 0.02);
        register(source, gain);
      }

      const peak = (0.16 * level) / Math.max(1, notes.length);
      const end = when + duration;
      const harmonic = warmth < 0.72;
      notes.forEach((midi, i) => {
        const start = when + (delays[i] ?? 0);
        const voice = context.createGain();
        const partial = context.createGain();
        partial.gain.value = 0.2 * (1 - warmth * 0.4);
        const stopAt = envelope(voice.gain, start, Math.max(end, start + 0.05), peak * (levels[i] ?? 1), {
          attack: 0.01 + softness * 0.3,
          decay: 0.55 + softness * 0.7,
          sustain: 0.48,
          release: (0.45 + softness * 0.85) * release * (1 + i * 0.05),
        });
        const sine = context.createOscillator();
        const triangle = context.createOscillator();
        sine.type = "sine";
        triangle.type = "triangle";
        const freq = midiToFreq(midi);
        sine.frequency.value = freq;
        triangle.frequency.value = freq;
        sine.detune.value = i % 2 === 0 ? -4 : 3;
        triangle.detune.value = i % 2 === 0 ? 6 : -5;
        sine.connect(voice);
        triangle.connect(partial);
        partial.connect(voice);
        voice.connect(filter);
        const oscs = [sine, triangle];
        let octaveGain: GainNode | null = null;
        if (harmonic) {
          const octave = context.createOscillator();
          octaveGain = context.createGain();
          octave.type = "sine";
          octave.frequency.value = freq * 2;
          octaveGain.gain.value = 0.06 * (1 - warmth);
          octave.connect(octaveGain);
          octaveGain.connect(voice);
          oscs.push(octave);
        }
        for (const osc of oscs) {
          osc.start(start);
          osc.stop(stopAt + 0.02);
        }
        const last = i === notes.length - 1;
        register(sine, ...(last ? [voice, filter] : [voice]));
        register(triangle, partial);
        if (oscs[2] && octaveGain) {
          register(oscs[2], octaveGain);
        }
      });
    },

    /** Soft plucked lead: sine plus a quiet detuned triangle through a closing low-pass. */
    lead(when: number, duration: number, midi: number, velocity: number) {
      const bright = sound.leadBrightness;
      const level = Math.min(1.15, Math.max(0, velocity));
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.5;
      filter.frequency.setValueAtTime(700 + bright * 2400, when);
      filter.frequency.setTargetAtTime(520 + bright * 900, when + 0.02, 0.1 + softness * 0.15);
      const env = context.createGain();
      const partial = context.createGain();
      partial.gain.value = 0.16;
      const sine = context.createOscillator();
      const triangle = context.createOscillator();
      sine.type = "sine";
      triangle.type = "triangle";
      const freq = midiToFreq(midi);
      sine.frequency.value = freq;
      triangle.frequency.value = freq;
      triangle.detune.value = 7;
      const stopAt = envelope(env.gain, when, when + duration, 0.08 * level, {
        attack: 0.008 + softness * 0.04,
        decay: 0.18 + softness * 0.2,
        sustain: 0.4,
        release: 0.28 + softness * 0.3,
      });
      sine.connect(env);
      triangle.connect(partial);
      partial.connect(env);
      env.connect(filter);
      filter.connect(buses.lead);
      sine.start(when);
      triangle.start(when);
      sine.stop(stopAt + 0.02);
      triangle.stop(stopAt + 0.02);
      register(sine, env, filter);
      register(triangle, partial);
    },
  };
}

export type Instruments = ReturnType<typeof createInstruments>;
