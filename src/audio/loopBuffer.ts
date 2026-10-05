const FADE_SECONDS = 0.85;

export type LoopHandle = {
  stop: (fadeSeconds?: number) => void;
};

export function pcmToAudioBuffer(
  context: AudioContext,
  samples: Float32Array,
  sampleRate: number,
) {
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  const channel = new Float32Array(samples);
  buffer.copyToChannel(channel, 0);
  return buffer;
}

export function startLoopingBuffer(
  context: AudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
): LoopHandle {
  const source = context.createBufferSource();
  const fade = context.createGain();

  source.buffer = buffer;
  source.loop = true;
  source.connect(fade);
  fade.connect(destination);

  const now = context.currentTime;
  fade.gain.value = 1;
  source.start(now);

  return {
    stop(fadeSeconds = FADE_SECONDS) {
      const t = context.currentTime;
      fade.gain.cancelScheduledValues(t);
      fade.gain.setValueAtTime(fade.gain.value, t);
      fade.gain.linearRampToValueAtTime(0, t + fadeSeconds);
      try {
        source.stop(t + fadeSeconds + 0.02);
      } catch {
        // already stopped
      }
      source.onended = () => {
        source.disconnect();
        fade.disconnect();
      };
    },
  };
}
