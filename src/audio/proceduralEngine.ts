import type { MusicBed } from "@/worlds/types";
import { createSampleBank, env, makeShaper, midiToFreq } from "@/audio/sampleBank";

const LOOKAHEAD = 0.3;
const TIMER_MS = 25;
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PROGRESSIONS = [
  [0, 5, 3, 7],
  [0, 3, 4, 0],
  [0, 7, 5, 3],
];
const PENTATONIC = [0, 3, 5, 7, 10];

function rand(seed: number) {
  const t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  const n = t + Math.imul(t ^ (t >>> 7), 61 | t);
  return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function stepRand(seed: number, step: number, lane: number) {
  return rand((seed + step * 9973 + lane * 7919) | 0);
}

function playBuffer(
  context: AudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  when: number,
  peak: number,
  playbackRate = 1,
) {
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  source.playbackRate.value = playbackRate;
  gain.gain.setValueAtTime(peak, when);
  gain.gain.setValueAtTime(peak, when + Math.max(0.02, buffer.duration - 0.03));
  gain.gain.linearRampToValueAtTime(0.0001, when + buffer.duration);
  source.connect(gain);
  gain.connect(destination);
  source.start(when);
}

export async function createProceduralEngine(
  context: AudioContext,
  destination: AudioNode,
) {
  const bank = await createSampleBank(context.sampleRate);

  const dry = context.createGain();
  const tape = makeShaper(context, 1.7);
  const compressor = context.createDynamicsCompressor();
  const tone = context.createBiquadFilter();
  const master = context.createGain();
  const reverb = context.createConvolver();
  const reverbGain = context.createGain();
  const delay = context.createDelay(1);
  const delayGain = context.createGain();
  const delayFilter = context.createBiquadFilter();
  const vinylGain = context.createGain();
  const vinylSource = context.createBufferSource();
  const wow = context.createOscillator();
  const wowGain = context.createGain();
  const duck = context.createGain();

  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 3.2;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.22;
  tone.type = "lowpass";
  tone.Q.value = 0.35;
  reverb.buffer = bank.ir;
  reverbGain.gain.value = 0.28;
  delay.delayTime.value = 0.375;
  delayGain.gain.value = 0.16;
  delayFilter.type = "lowpass";
  delayFilter.frequency.value = 2200;
  vinylGain.gain.value = 0;
  wow.frequency.value = 0.18;
  wowGain.gain.value = 18;
  duck.gain.value = 1;
  master.gain.value = 0.9;

  dry.connect(duck);
  duck.connect(tape);
  tape.connect(compressor);
  compressor.connect(tone);
  tone.connect(master);
  master.connect(destination);
  tone.connect(reverb);
  reverb.connect(reverbGain);
  reverbGain.connect(master);
  tone.connect(delay);
  delay.connect(delayFilter);
  delayFilter.connect(delayGain);
  delayGain.connect(tone);
  vinylSource.buffer = bank.vinyl;
  vinylSource.loop = true;
  vinylSource.connect(vinylGain);
  vinylGain.connect(destination);
  wow.connect(wowGain);
  wowGain.connect(tone.detune);

  let vinylStarted = false;
  let wowStarted = false;
  let style: MusicBed | null = null;
  let timer = 0;
  let step = 0;
  let nextTime = 0;
  let running = false;

  const playKick = (when: number, velocity: number) => {
    playBuffer(context, dry, bank.kick, when, 0.72 * velocity, 0.97 + velocity * 0.04);
    duck.gain.setValueAtTime(1, when);
    duck.gain.linearRampToValueAtTime(0.72, when + 0.03);
    duck.gain.linearRampToValueAtTime(1, when + 0.18);
  };

  const playBass = (when: number, midi: number, velocity: number) => {
    const osc = context.createOscillator();
    const sub = context.createOscillator();
    const lp = context.createBiquadFilter();
    const gain = context.createGain();
    const shaper = makeShaper(context, 1.4);
    osc.type = "triangle";
    sub.type = "sine";
    osc.frequency.value = midiToFreq(midi);
    sub.frequency.value = midiToFreq(midi);
    lp.type = "lowpass";
    lp.Q.value = 1.1;
    lp.frequency.setValueAtTime(640, when);
    lp.frequency.exponentialRampToValueAtTime(140, when + 0.32);
    env(gain.gain, when, 0.28 * velocity, 0.01, 0.42);
    osc.connect(lp);
    sub.connect(lp);
    lp.connect(shaper);
    shaper.connect(gain);
    gain.connect(dry);
    osc.start(when);
    sub.start(when);
    osc.stop(when + 0.5);
    sub.stop(when + 0.5);
  };

  const playChord = (when: number, midiNotes: number[], brightness: number) => {
    for (const midi of midiNotes) {
      const car = context.createOscillator();
      const mod = context.createOscillator();
      const detune = context.createOscillator();
      const modGain = context.createGain();
      const gain = context.createGain();
      const hammer = context.createBufferSource();
      const hammerGain = context.createGain();
      const freq = midiToFreq(midi);
      car.type = "sine";
      detune.type = "sine";
      mod.type = "sine";
      car.frequency.value = freq;
      detune.frequency.value = freq * 1.003;
      mod.frequency.value = freq * 2.01;
      modGain.gain.setValueAtTime(freq * brightness, when);
      modGain.gain.exponentialRampToValueAtTime(freq * 0.15, when + 0.4);
      env(gain.gain, when, 0.055, 0.02, 2.1);
      env(hammerGain.gain, when, 0.03, 0.001, 0.04);
      hammer.buffer = bank.hat;
      mod.connect(modGain);
      modGain.connect(car.frequency);
      car.connect(gain);
      detune.connect(gain);
      hammer.connect(hammerGain);
      gain.connect(dry);
      hammerGain.connect(dry);
      car.start(when);
      detune.start(when);
      mod.start(when);
      hammer.start(when);
      car.stop(when + 2.3);
      detune.stop(when + 2.3);
      mod.stop(when + 2.3);
    }
  };

  const playLead = (when: number, midi: number) => {
    const osc = context.createOscillator();
    const osc2 = context.createOscillator();
    const gain = context.createGain();
    osc.type = "sine";
    osc2.type = "triangle";
    osc.frequency.value = midiToFreq(midi);
    osc2.frequency.value = midiToFreq(midi);
    osc2.detune.value = 6;
    env(gain.gain, when, 0.06, 0.015, 0.55);
    osc.connect(gain);
    osc2.connect(gain);
    gain.connect(dry);
    osc.start(when);
    osc2.start(when);
    osc.stop(when + 0.7);
    osc2.stop(when + 0.7);
  };

  const scheduleStep = (currentStyle: MusicBed, currentStep: number, when: number) => {
    const barStep = currentStep % 16;
    const progression = PROGRESSIONS[currentStyle.seed % PROGRESSIONS.length] ?? PROGRESSIONS[0];
    const chordIndex = Math.floor((currentStep % 64) / 16);
    const degree = progression[chordIndex] ?? 0;
    const root = currentStyle.rootMidi + (MINOR[degree] ?? 0);
    const ninth = root + 14;
    const kickV = 0.86 + stepRand(currentStyle.seed, currentStep, 1) * 0.14;

    if (barStep === 0 || (barStep === 8 && stepRand(currentStyle.seed, currentStep, 3) > 0.42)) {
      playKick(when, kickV);
    }
    if (barStep === 8) {
      playBuffer(
        context,
        dry,
        bank.snare,
        when + 0.01,
        0.38 + stepRand(currentStyle.seed, currentStep, 2) * 0.1,
        0.98,
      );
    }
    if (barStep % 2 === 0) {
      const open = barStep === 14;
      playBuffer(
        context,
        dry,
        open ? bank.openHat : bank.hat,
        when,
        open ? 0.16 : 0.11,
        0.96 + stepRand(currentStyle.seed, currentStep, 7) * 0.08,
      );
    }
    if (barStep === 0 || barStep === 7 || barStep === 10 || barStep === 12) {
      const walk = stepRand(currentStyle.seed, currentStep, 4) > 0.7 ? 7 : 0;
      playBass(when, root - 12 + walk, 0.92);
    }
    if (barStep === 0) {
      playChord(
        when,
        [root + 12, root + 15, root + 22, ninth + 12],
        0.9 + clamp01(currentStyle.brightness) * 0.75,
      );
    }
    if (barStep % 4 === 0 && stepRand(currentStyle.seed, currentStep, 5) > 0.55) {
      const toneIndex = Math.floor(
        stepRand(currentStyle.seed, currentStep, 6) * PENTATONIC.length,
      );
      playLead(when, root + 24 + (PENTATONIC[toneIndex] ?? 0));
    }
  };

  const tick = () => {
    if (!running || !style) {
      return;
    }

    const sixteenth = 60 / style.bpm / 4;
    while (nextTime < context.currentTime + LOOKAHEAD) {
      const swung =
        step % 2 === 1 ? nextTime + sixteenth * (style.swing * 2 - 1) : nextTime;
      const human = (stepRand(style.seed, step, 0) - 0.5) * 0.012;
      scheduleStep(style, step, Math.max(swung + human, context.currentTime + 0.02));
      nextTime += sixteenth;
      step += 1;
    }
  };

  return {
    start(nextStyle: MusicBed) {
      window.clearInterval(timer);
      running = false;
      style = nextStyle;
      tone.frequency.value = 1800 + clamp01(nextStyle.brightness) * 3000;
      vinylGain.gain.setTargetAtTime(
        0.02 + clamp01(nextStyle.texture) * 0.1,
        context.currentTime,
        0.05,
      );
      if (!vinylStarted) {
        vinylSource.start();
        vinylStarted = true;
      }
      if (!wowStarted) {
        wow.start();
        wowStarted = true;
      }
      running = true;
      step = 0;
      nextTime = context.currentTime + 0.04;
      tick();
      timer = window.setInterval(tick, TIMER_MS);
    },
    stop() {
      running = false;
      window.clearInterval(timer);
      vinylGain.gain.setTargetAtTime(0.0001, context.currentTime, 0.05);
    },
  };
}

export type ProceduralEngine = Awaited<ReturnType<typeof createProceduralEngine>>;
