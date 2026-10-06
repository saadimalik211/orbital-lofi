import type { Composition } from "@/audio/music/composer";
import { createInstruments, type RegisterSource } from "@/audio/music/instruments";

/** How far ahead notes are committed to the AudioContext clock, and how often we top up. */
const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
const START_DELAY_S = 0.1;
const STOP_FADE_S = 0.04;

export type MusicEngine = {
  /** Stops anything playing, then loops `composition` from its first bar. */
  play: (composition: Composition) => void;
  stop: () => void;
  dispose: () => void;
};

function createImpulse(context: BaseAudioContext, seconds: number) {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }
  }
  return buffer;
}

/**
 * drums ─────────────┐
 * hats → pan ────────┤
 * bass → low-pass ───┼→ mix → tone low-pass → out → destination
 * keys → low-pass ───┤        ↘ reverb send → convolver ↗
 * lead → low-pass → pan
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
  const pan = (value: number) => node(() => context.createStereoPanner(), (p) => (p.pan.value = value));

  const out = gain(0);
  const tone = lowpass(6000);
  const mix = gain(0.9);
  const reverb = node(() => context.createConvolver(), (c) => (c.buffer = createImpulse(context, 2.8)));
  const reverbSend = gain(0.3);
  const drums = gain(0.8);
  const hats = pan(0.22);
  const bassFilter = lowpass(650);
  const keysFilter = lowpass(2400);
  const leadFilter = lowpass(3200);
  const leadPan = pan(-0.18);
  const drumSend = gain(0.15);

  drums.connect(mix);
  hats.connect(drums);
  bassFilter.connect(mix);
  keysFilter.connect(mix);
  keysFilter.connect(reverbSend);
  leadFilter.connect(leadPan);
  leadPan.connect(mix);
  leadPan.connect(reverbSend);
  drums.connect(drumSend);
  drumSend.connect(reverbSend);
  reverbSend.connect(reverb);
  mix.connect(tone);
  tone.connect(out);
  reverb.connect(out);
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
    { drums, hats, bass: bassFilter, keys: keysFilter, lead: leadFilter },
    register,
  );

  let timer = 0;
  let composition: Composition | null = null;
  /** Per-16th-step note callbacks for the current loop, built once per composition. */
  let slots: ((when: number) => void)[][] = [];
  let step = 0;
  let nextTime = 0;

  const index = (c: Composition, sixteenth: number) => {
    const table: ((when: number) => void)[][] = Array.from({ length: c.steps }, () => []);
    const at = (s: number, fn: (when: number) => void) => table[s % c.steps].push(fn);
    for (const hit of c.drums) {
      at(hit.step, (when) => instruments[hit.kind](when, hit.velocity));
    }
    for (const n of c.bass) {
      at(n.step, (when) => instruments.bass(when, n.length * sixteenth, n.midi, n.velocity));
    }
    for (const chord of c.chords) {
      at(chord.step, (when) => instruments.keys(when, chord.length * sixteenth, chord.notes, chord.velocity));
    }
    for (const n of c.melody) {
      at(n.step, (when) => instruments.lead(when, n.length * sixteenth, n.midi, n.velocity));
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
    play(next) {
      stop();
      const now = context.currentTime;
      const { reverb: wet, brightness, softness } = next.space;
      reverbSend.gain.setValueAtTime(0.05 + wet * 0.55, now);
      tone.frequency.setValueAtTime(1800 + brightness * 7000, now);
      keysFilter.frequency.setValueAtTime(900 + brightness * 3200, now);
      leadFilter.frequency.setValueAtTime(1600 + brightness * 3600, now);
      instruments.setSoftness(softness);

      composition = next;
      slots = index(next, 60 / next.bpm / 4);
      step = 0;
      nextTime = now + START_DELAY_S;
      out.gain.setValueAtTime(0, now + STOP_FADE_S + 0.01);
      out.gain.linearRampToValueAtTime(1, now + START_DELAY_S - 0.01);
      tick();
      timer = window.setInterval(tick, TICK_MS);
    },
    stop,
    dispose() {
      stop();
      for (const n of [out, tone, mix, reverb, reverbSend, drums, hats, bassFilter, keysFilter, leadFilter, leadPan, drumSend]) {
        n.disconnect();
      }
    },
  };
}
