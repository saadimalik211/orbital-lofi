function midiToFreq(midi: number) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function env(
  gain: AudioParam,
  when: number,
  peak: number,
  attack: number,
  release: number,
) {
  gain.setValueAtTime(0.0001, when);
  gain.exponentialRampToValueAtTime(peak, when + attack);
  gain.exponentialRampToValueAtTime(0.0001, when + attack + release);
}

function makeShaper(context: BaseAudioContext, amount = 2.2) {
  const curve = new Float32Array(256);
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount);
  }
  const shaper = context.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = "2x";
  return shaper;
}

async function render(
  sampleRate: number,
  seconds: number,
  channels: number,
  setup: (context: OfflineAudioContext) => void,
) {
  const context = new OfflineAudioContext(
    channels,
    Math.max(1, Math.floor(sampleRate * seconds)),
    sampleRate,
  );
  setup(context);
  return context.startRendering();
}

export type SampleBank = {
  kick: AudioBuffer;
  snare: AudioBuffer;
  hat: AudioBuffer;
  openHat: AudioBuffer;
  vinyl: AudioBuffer;
  ir: AudioBuffer;
};

export async function createSampleBank(sampleRate: number): Promise<SampleBank> {
  const kick = await render(sampleRate, 0.55, 1, (offline) => {
    const osc = offline.createOscillator();
    const click = offline.createOscillator();
    const body = offline.createGain();
    const clickGain = offline.createGain();
    const shaper = makeShaper(offline, 1.8);
    osc.type = "sine";
    click.type = "sine";
    osc.frequency.setValueAtTime(168, 0);
    osc.frequency.exponentialRampToValueAtTime(42, 0.12);
    click.frequency.value = 2400;
    env(body.gain, 0, 0.95, 0.004, 0.42);
    env(clickGain.gain, 0, 0.18, 0.001, 0.018);
    osc.connect(body);
    click.connect(clickGain);
    body.connect(shaper);
    clickGain.connect(shaper);
    shaper.connect(offline.destination);
    osc.start(0);
    click.start(0);
    osc.stop(0.5);
    click.stop(0.03);
  });

  const snare = await render(sampleRate, 0.45, 1, (offline) => {
    const noise = offline.createBufferSource();
    const noiseBuffer = offline.createBuffer(1, Math.floor(sampleRate * 0.45), sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    const hp = offline.createBiquadFilter();
    const bp = offline.createBiquadFilter();
    const tone = offline.createOscillator();
    const noiseGain = offline.createGain();
    const toneGain = offline.createGain();
    noise.buffer = noiseBuffer;
    hp.type = "highpass";
    hp.frequency.value = 900;
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    tone.type = "triangle";
    tone.frequency.value = 196;
    env(noiseGain.gain, 0, 0.7, 0.003, 0.22);
    env(toneGain.gain, 0, 0.22, 0.002, 0.09);
    noise.connect(hp);
    hp.connect(bp);
    bp.connect(noiseGain);
    tone.connect(toneGain);
    noiseGain.connect(offline.destination);
    toneGain.connect(offline.destination);
    noise.start(0);
    tone.start(0);
    tone.stop(0.2);
  });

  const renderHat = (seconds: number, peak: number, release: number) =>
    render(sampleRate, seconds, 1, (offline) => {
      const noise = offline.createBufferSource();
      const buffer = offline.createBuffer(1, Math.floor(sampleRate * seconds), sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        data[i] = Math.random() * 2 - 1;
      }
      const hp = offline.createBiquadFilter();
      const bp = offline.createBiquadFilter();
      const gain = offline.createGain();
      noise.buffer = buffer;
      hp.type = "highpass";
      hp.frequency.value = 8000;
      bp.type = "bandpass";
      bp.frequency.value = 11000;
      bp.Q.value = 0.8;
      env(gain.gain, 0, peak, 0.001, release);
      noise.connect(hp);
      hp.connect(bp);
      bp.connect(gain);
      gain.connect(offline.destination);
      noise.start(0);
    });

  const [hat, openHat] = await Promise.all([
    renderHat(0.18, 0.28, 0.05),
    renderHat(0.4, 0.22, 0.22),
  ]);

  const vinyl = await render(sampleRate, 7.2, 2, (offline) => {
    const length = Math.floor(sampleRate * 7.2);
    const buffer = offline.createBuffer(2, length, sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        const hiss = (Math.random() * 2 - 1) * 0.03;
        const pop = Math.random() > 0.9994 ? (Math.random() * 2 - 1) * 0.55 : 0;
        const scratch =
          Math.floor(i / (sampleRate * 1.8)) !== Math.floor((i - 1) / (sampleRate * 1.8)) &&
          Math.random() > 0.4
            ? (Math.random() * 2 - 1) * 0.2
            : 0;
        data[i] = hiss + pop + scratch;
      }
    }
    const source = offline.createBufferSource();
    const filter = offline.createBiquadFilter();
    source.buffer = buffer;
    filter.type = "highpass";
    filter.frequency.value = 400;
    source.connect(filter);
    filter.connect(offline.destination);
    source.start(0);
  });

  const ir = await render(sampleRate, 1.6, 2, (offline) => {
    const length = Math.floor(sampleRate * 1.6);
    const buffer = offline.createBuffer(2, length, sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        const t = i / length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.4) * 0.35;
      }
    }
    const source = offline.createBufferSource();
    const lp = offline.createBiquadFilter();
    source.buffer = buffer;
    lp.type = "lowpass";
    lp.frequency.value = 4200;
    source.connect(lp);
    lp.connect(offline.destination);
    source.start(0);
  });

  return { kick, snare, hat, openHat, vinyl, ir };
}

export { midiToFreq, env, makeShaper };
