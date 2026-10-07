/** Synthesized voices. Every note starts and ends at zero gain so nothing clicks. */

import type { MusicSound } from "@/worlds/types";

export type InstrumentBuses = {
  drums: AudioNode;
  snare: AudioNode;
  hats: AudioNode;
  bass: AudioNode;
  /** Quiet octave layer. Saturated a little, then joined with the fundamental. */
  bassHarmonic: AudioNode;
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
    bassPresence: 0.4,
    textureAmount: 0,
  };
  /** Seeded Hz offset for the snare's tonal layer. Same seed, same pitch. */
  let snareTune = 0;
  /** Flips each hat so consecutive hits are not stacked on one side. Reset per composition. */
  let hatSide = 1;

  const nextHatPan = () => {
    hatSide = -hatSide;
    return hatSide * 0.2;
  };

  const noiseHit = (
    destination: AudioNode,
    when: number,
    filterType: BiquadFilterType,
    frequency: number,
    peak: number,
    decay: number,
    q = 0.7,
    extras?: { lowpass?: number; pan?: number },
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
    const chain: AudioNode[] = [filter, gain];
    let output: AudioNode = gain;
    if (extras?.lowpass) {
      const low = context.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.value = extras.lowpass;
      low.Q.value = 0.5;
      gain.connect(low);
      output = low;
      chain.push(low);
    }
    if (extras?.pan !== undefined) {
      const panner = context.createStereoPanner();
      panner.pan.value = extras.pan;
      output.connect(panner);
      panner.connect(destination);
      chain.push(panner);
    } else {
      output.connect(destination);
    }
    noiseCursor = (noiseCursor + 0.037) % 0.5;
    source.start(when, noiseCursor);
    source.stop(stopAt + 0.02);
    register(source, ...chain);
  };

  return {
    setSound(next: MusicSound, nextSoftness: number, tune: number) {
      sound = {
        kickSoftness: clamp01(next.kickSoftness),
        snareBrightness: clamp01(next.snareBrightness),
        hatBrightness: clamp01(next.hatBrightness),
        chordWarmth: clamp01(next.chordWarmth),
        leadBrightness: clamp01(next.leadBrightness),
        bassPresence: clamp01(next.bassPresence),
        textureAmount: clamp01(next.textureAmount),
      };
      softness = clamp01(nextSoftness);
      snareTune = tune;
      hatSide = 1;
    },

    /**
     * Warm kick: a sine that falls onto a low note, plus a very short band-passed click.
     * `color` is a seeded 0–1 offset so repeated hits are not copies. Softness still
     * decides how round the body is and how quiet the click stays.
     */
    kick(when: number, velocity: number, color = 0.5) {
      const soft = sound.kickSoftness;
      const level = Math.min(1.15, Math.max(0, velocity));
      const vel = Math.min(1, level);
      const shade = Math.min(1, Math.max(0, color));
      const body = context.createOscillator();
      const gain = context.createGain();
      body.type = "sine";
      const endHz = Math.max(36, 44 + (1 - soft) * 8 + (shade - 0.5) * 1.2);
      const startHz = Math.max(endHz * 1.2, 72 + (1 - soft) * 48 + (shade - 0.5) * 8 + (vel - 0.75) * 3);
      const drop = (0.07 + soft * 0.04) * (1.05 - vel * 0.1);
      body.frequency.setValueAtTime(startHz, when);
      body.frequency.exponentialRampToValueAtTime(endHz, when + drop);
      const stopAt = envelope(gain.gain, when, when + 0.016, 0.46 * level * (0.85 + 0.15 * (1 - soft)) * (0.97 + shade * 0.06), {
        attack: 0.003,
        decay: (0.06 + soft * 0.03) * (0.92 + shade * 0.16),
        sustain: 0,
        release: 0.14 + soft * 0.06,
      });
      body.connect(gain);
      gain.connect(buses.drums);
      body.start(when);
      body.stop(stopAt + 0.02);
      register(body, gain);

      const click = 0.12 * level * (1 - soft * 0.88) * (0.88 + shade * 0.24) * (0.92 + vel * 0.12);
      if (click > 0.012) {
        noiseHit(
          buses.drums,
          when,
          "bandpass",
          (1400 + (1 - soft) * 900) * (0.94 + shade * 0.12),
          click,
          (0.007 + (1 - soft) * 0.005) * (0.9 + shade * 0.2),
          0.6,
        );
      }
    },

    /** Soft lofi snare: a dark noise body, a quieter low thump, and a sine that falls. */
    snare(when: number, velocity: number) {
      const bright = sound.snareBrightness;
      const level = Math.min(1.15, Math.max(0, velocity));
      noiseHit(buses.snare, when, "bandpass", 650 + bright * 1100, 0.24 * level, 0.04 + bright * 0.012, 0.65);
      noiseHit(buses.snare, when, "lowpass", 420, 0.07 * level, 0.028, 0.5);
      const tone = context.createOscillator();
      const gain = context.createGain();
      tone.type = "sine";
      const startHz = (188 + bright * 36 + snareTune) * (0.96 + 0.08 * Math.min(1, level));
      tone.frequency.setValueAtTime(startHz, when);
      tone.frequency.exponentialRampToValueAtTime(Math.max(70, startHz * 0.74), when + 0.05);
      const stopAt = envelope(gain.gain, when, when + 0.008, 0.09 * level, {
        attack: 0.002,
        decay: 0.022,
        sustain: 0,
        release: 0.045,
      });
      tone.connect(gain);
      gain.connect(buses.snare);
      tone.start(when);
      tone.stop(stopAt + 0.02);
      register(tone, gain);
    },

    hat(when: number, velocity: number) {
      const bright = sound.hatBrightness;
      const level = Math.min(1.15, Math.max(0, velocity));
      const center = (2600 + bright * 1400) * (0.92 + 0.16 * level);
      noiseHit(buses.hats, when, "bandpass", center, 0.15 * level, (0.02 + (1 - bright) * 0.012) * (0.88 + 0.24 * level), 1.7, {
        lowpass: 5200 + bright * 1400,
        pan: nextHatPan(),
      });
    },

    /** Same noise as the closed hat, held longer, tuned lower, and a little wider. */
    openHat(when: number, velocity: number) {
      const bright = sound.hatBrightness;
      const level = Math.min(1.15, Math.max(0, velocity));
      const center = (2100 + bright * 1100) * (0.94 + 0.12 * level);
      noiseHit(buses.hats, when, "bandpass", center, 0.11 * level, (0.055 + bright * 0.02) * (0.9 + 0.2 * level), 1.15, {
        lowpass: 4600 + bright * 1200,
        pan: nextHatPan(),
      });
    },

    /**
     * Sine fundamental plus a quiet triangle, kept clean. A softer sine an octave
     * up carries the note on small speakers. `color` is a seeded 0–1 tone offset.
     */
    bass(when: number, duration: number, midi: number, velocity: number, color: number) {
      const level = Math.min(1.15, Math.max(0, velocity));
      const vel = Math.min(1, level);
      const presence = sound.bassPresence;
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

      const harmonic = context.createGain();
      const harmonicFilter = context.createBiquadFilter();
      const octave = context.createOscillator();
      harmonicFilter.type = "lowpass";
      harmonicFilter.Q.value = 0.5;
      harmonicFilter.frequency.setValueAtTime((260 + presence * 70 + vel * 140) * (0.94 + color * 0.1), when);
      octave.type = "sine";
      octave.frequency.value = freq * 2;
      octave.detune.setValueAtTime((color - 0.5) * 3, when);
      const harmonicStop = envelope(harmonic.gain, when, when + duration, (0.04 + presence * 0.07) * (0.78 + 0.32 * vel), {
        attack: 0.01 + softness * 0.016,
        decay: 0.3,
        sustain: 0.72,
        release: 0.12,
      });
      octave.connect(harmonicFilter);
      harmonicFilter.connect(harmonic);
      harmonic.connect(buses.bassHarmonic);
      octave.start(when);
      octave.stop(harmonicStop + 0.02);
      register(octave, harmonicFilter, harmonic);
    },

    /**
     * Mellow electric keys. The body is a sine plus a quiet detuned triangle that
     * follows the slow envelope. A short octave and third-harmonic strike fades first, so
     * the attack has a soft hammer and the sustain stays dark. Warmer profiles
     * quiet that strike. Notes of a chord sit a little apart in the stereo field.
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
      const strikeAmount = 0.4 + (1 - warmth) * 0.22;
      notes.forEach((midi, i) => {
        const start = when + (delays[i] ?? 0);
        const voice = context.createGain();
        const partial = context.createGain();
        const panner = context.createStereoPanner();
        partial.gain.value = 0.2 * (1 - warmth * 0.4);
        panner.pan.value = notes.length <= 1 ? 0 : ((i + 0.5) / notes.length - 0.5) * 0.32;
        const noteLevel = peak * (levels[i] ?? 1);
        const stopAt = envelope(voice.gain, start, Math.max(end, start + 0.05), noteLevel, {
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
        voice.connect(panner);

        const strike = context.createGain();
        const strikeStop = envelope(strike.gain, start, start + 0.08, noteLevel * strikeAmount, {
          attack: 0.005,
          decay: 0.045,
          sustain: 0.2,
          release: 0.07,
        });
        const octave = context.createOscillator();
        const third = context.createOscillator();
        const thirdGain = context.createGain();
        const stretch = Math.min(6, Math.max(0, (midi - 57) * 0.1));
        octave.type = "sine";
        third.type = "sine";
        thirdGain.gain.value = 0.2;
        octave.frequency.value = freq * 2;
        third.frequency.value = freq * 3;
        octave.detune.value = 4 + stretch;
        third.detune.value = 7 + stretch;
        octave.connect(strike);
        third.connect(thirdGain);
        thirdGain.connect(strike);
        strike.connect(panner);
        panner.connect(filter);

        sine.start(start);
        triangle.start(start);
        octave.start(start);
        third.start(start);
        sine.stop(stopAt + 0.02);
        triangle.stop(stopAt + 0.02);
        octave.stop(strikeStop + 0.02);
        third.stop(strikeStop + 0.02);
        const last = i === notes.length - 1;
        register(sine, voice, panner, ...(last ? [filter] : []));
        register(triangle, partial);
        register(octave, strike);
        register(third, thirdGain);
      });
    },

    /**
     * Soft muted pluck. The body is still a quiet sine and triangle. A short octave
     * partial gives the attack an identity, then the low-pass closes. `color` is a
     * seeded 0–1 offset for cutoff and pan. The note stays left of center.
     */
    lead(when: number, duration: number, midi: number, velocity: number, color: number) {
      const bright = sound.leadBrightness;
      const level = Math.min(1.15, Math.max(0, velocity));
      const vel = Math.min(1, level);
      const shade = 0.94 + color * 0.1;
      const filter = context.createBiquadFilter();
      const panner = context.createStereoPanner();
      filter.type = "lowpass";
      filter.Q.value = 0.5;
      filter.frequency.setValueAtTime((680 + bright * 2000) * shade * (0.9 + vel * 0.16), when);
      filter.frequency.setTargetAtTime((480 + bright * 780) * (0.97 + color * 0.05), when + 0.018, 0.09 + softness * 0.14);
      panner.pan.value = -0.12 + (color - 0.5) * 0.16;
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
      triangle.detune.value = 5 + color * 4;
      const stopAt = envelope(env.gain, when, when + duration, 0.08 * level, {
        attack: 0.008 + softness * 0.04,
        decay: 0.18 + softness * 0.2,
        sustain: 0.4,
        release: (0.28 + softness * 0.3) * (1.05 - vel * 0.1),
      });
      sine.connect(env);
      triangle.connect(partial);
      partial.connect(env);
      env.connect(filter);

      const pluck = context.createGain();
      const octave = context.createOscillator();
      octave.type = "sine";
      octave.frequency.value = freq * 2;
      octave.detune.value = 3 + color * 3;
      const pluckStop = envelope(pluck.gain, when, when + 0.05, 0.08 * level * (0.2 + bright * 0.16) * (1 - softness * 0.28), {
        attack: 0.006 + softness * 0.008,
        decay: 0.035,
        sustain: 0.1,
        release: 0.05,
      });
      octave.connect(pluck);
      pluck.connect(filter);
      filter.connect(panner);
      panner.connect(buses.lead);
      sine.start(when);
      triangle.start(when);
      octave.start(when);
      sine.stop(stopAt + 0.02);
      triangle.stop(stopAt + 0.02);
      octave.stop(pluckStop + 0.02);
      register(sine, env, filter, panner);
      register(triangle, partial);
      register(octave, pluck);
    },
  };
}

export type Instruments = ReturnType<typeof createInstruments>;
