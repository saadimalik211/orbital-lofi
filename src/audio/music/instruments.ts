/** Synthesized voices. Every note starts and ends at zero gain so nothing clicks. */

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
  /** 0 = snappy, 1 = slow soft attacks. Set per composition. */
  let softness = 0.5;

  const noiseHit = (
    destination: AudioNode,
    when: number,
    filterType: BiquadFilterType,
    frequency: number,
    peak: number,
    decay: number,
  ) => {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = noise;
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = 0.8;
    const stopAt = envelope(gain.gain, when, when + 0.004, peak, {
      attack: 0.002,
      decay,
      sustain: 0,
      release: decay * 2,
    });
    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    source.start(when, Math.random() * 0.5);
    source.stop(stopAt + 0.02);
    register(source, filter, gain);
  };

  return {
    setSoftness(value: number) {
      softness = Math.min(1, Math.max(0, value));
    },

    kick(when: number, velocity: number) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(115, when);
      osc.frequency.exponentialRampToValueAtTime(44, when + 0.12);
      const stopAt = envelope(gain.gain, when, when + 0.02, 0.85 * velocity, {
        attack: 0.003,
        decay: 0.09,
        sustain: 0,
        release: 0.3,
      });
      osc.connect(gain);
      gain.connect(buses.drums);
      osc.start(when);
      osc.stop(stopAt + 0.02);
      register(osc, gain);
    },

    snare(when: number, velocity: number) {
      noiseHit(buses.drums, when, "bandpass", 1900, 0.42 * velocity, 0.055);
      const body = context.createOscillator();
      const gain = context.createGain();
      body.type = "triangle";
      body.frequency.value = 185;
      const stopAt = envelope(gain.gain, when, when + 0.01, 0.18 * velocity, {
        attack: 0.002,
        decay: 0.03,
        sustain: 0,
        release: 0.08,
      });
      body.connect(gain);
      gain.connect(buses.drums);
      body.start(when);
      body.stop(stopAt + 0.02);
      register(body, gain);
    },

    hat(when: number, velocity: number) {
      noiseHit(buses.hats, when, "highpass", 6800 + 900 * velocity, 0.16 * velocity, 0.018);
    },

    /** Longer, slightly darker hat tail standing in for an open hi-hat. */
    openHat(when: number, velocity: number) {
      noiseHit(buses.hats, when, "highpass", 6200, 0.11 * velocity, 0.085);
    },

    bass(when: number, duration: number, midi: number, velocity: number) {
      const sub = context.createOscillator();
      const body = context.createOscillator();
      const bodyGain = context.createGain();
      const gain = context.createGain();
      sub.type = "sine";
      body.type = "triangle";
      sub.frequency.value = midiToFreq(midi);
      body.frequency.value = midiToFreq(midi);
      bodyGain.gain.value = 0.35;
      const stopAt = envelope(gain.gain, when, when + duration, 0.42 * velocity, {
        attack: 0.012 + softness * 0.03,
        decay: 0.35,
        sustain: 0.7,
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
     * Warm electric-keys chord. Per note: a sine body plus a quiet, slowly drifting sawtooth.
     * A per-chord low-pass opens on the attack and settles, like a struck tine mellowing out.
     */
    keys(when: number, duration: number, chord: KeysChord) {
      const { notes, delays, levels, release, velocity } = chord;
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.7;
      filter.frequency.setValueAtTime(2200 + 2600 * velocity * (1 - softness * 0.45), when);
      filter.frequency.setTargetAtTime(700 + 700 * velocity, when + 0.01, 0.18 + softness * 0.5);
      filter.connect(buses.keys);

      const peak = (0.2 * velocity) / Math.max(1, notes.length);
      const end = when + duration;
      notes.forEach((midi, i) => {
        const start = when + (delays[i] ?? 0);
        const voice = context.createGain();
        const sawLevel = context.createGain();
        sawLevel.gain.value = 0.16;
        // Later voices start later and release a touch longer, so the last one ends last.
        const stopAt = envelope(voice.gain, start, Math.max(end, start + 0.05), peak * (levels[i] ?? 1), {
          attack: 0.012 + softness * 0.33,
          decay: 0.6 + softness * 0.8,
          sustain: 0.5,
          release: (0.5 + softness * 0.9) * release * (1 + i * 0.04),
        });
        const sine = context.createOscillator();
        const saw = context.createOscillator();
        sine.type = "sine";
        saw.type = "sawtooth";
        sine.frequency.value = midiToFreq(midi);
        saw.frequency.value = midiToFreq(midi);
        sine.detune.value = i - 3;
        saw.detune.setValueAtTime(7 - i, start);
        saw.detune.linearRampToValueAtTime(3 - i, stopAt);
        sine.connect(voice);
        saw.connect(sawLevel);
        sawLevel.connect(voice);
        voice.connect(filter);
        for (const osc of [sine, saw]) {
          osc.start(start);
          osc.stop(stopAt + 0.02);
        }
        register(sine, voice);
        register(saw, ...(i === notes.length - 1 ? [sawLevel, filter] : [sawLevel]));
      });
    },

    lead(when: number, duration: number, midi: number, velocity: number) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = "triangle";
      osc.frequency.value = midiToFreq(midi);
      const stopAt = envelope(gain.gain, when, when + duration, 0.11 * velocity, {
        attack: 0.006 + softness * 0.07,
        decay: 0.22 + softness * 0.3,
        sustain: 0.35,
        release: 0.25 + softness * 0.4,
      });
      osc.connect(gain);
      gain.connect(buses.lead);
      osc.start(when);
      osc.stop(stopAt + 0.02);
      register(osc, gain);
    },
  };
}

export type Instruments = ReturnType<typeof createInstruments>;
