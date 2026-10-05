import type { AmbienceTrack, World } from "@/worlds/types";

const bufferCache = new Map<string, Promise<AudioBuffer>>();

export type AmbienceVoice = {
  id: string;
  gain: GainNode;
  stop: () => void;
};

export function loadAmbienceBuffer(context: AudioContext, src: string) {
  const cached = bufferCache.get(src);
  if (cached) {
    return cached;
  }

  const pending = fetch(src)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Ambience missing: ${src}`);
      }
      return response.arrayBuffer();
    })
    .then((data) => context.decodeAudioData(data.slice(0)))
    .catch((error: unknown) => {
      bufferCache.delete(src);
      throw error;
    });

  bufferCache.set(src, pending);
  return pending;
}

export function preloadWorldAmbience(context: AudioContext, world: World) {
  for (const track of world.ambience) {
    void loadAmbienceBuffer(context, track.src).catch(() => {});
  }
}

export function startAmbienceVoice(
  context: AudioContext,
  destination: AudioNode,
  track: AmbienceTrack,
  buffer: AudioBuffer,
  volume: number,
): AmbienceVoice {
  const gain = context.createGain();
  const source = context.createBufferSource();
  gain.gain.value = volume;
  source.buffer = buffer;
  source.loop = true;
  source.connect(gain);
  gain.connect(destination);
  source.start();

  return {
    id: track.id,
    gain,
    stop() {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
      gain.disconnect();
    },
  };
}

export function stopAmbienceVoices(voices: Map<string, AmbienceVoice>) {
  for (const voice of voices.values()) {
    voice.stop();
  }
  voices.clear();
}
