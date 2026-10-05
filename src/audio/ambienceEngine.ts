import type { AmbienceTrack, World } from "@/worlds/types";

const bufferCache = new Map<string, Promise<AudioBuffer>>();
const warned = new Set<string>();

export type AmbienceVoice = {
  track: AmbienceTrack;
  gain: GainNode;
  stop: () => void;
};

function warnMissing(src: string, error: unknown) {
  if (process.env.NODE_ENV === "production" || warned.has(src)) {
    return;
  }
  warned.add(src);
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[orbital-lofi] Audio unavailable: ${src} (${reason})`);
}

/** Fetches and decodes a sound once per `src`. Failed loads are retried next call. */
export function loadAudioBuffer(context: BaseAudioContext, src: string) {
  const cached = bufferCache.get(src);
  if (cached) {
    return cached;
  }

  const pending = fetch(src)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.arrayBuffer();
    })
    .then((data) => context.decodeAudioData(data))
    .catch((error: unknown) => {
      bufferCache.delete(src);
      warnMissing(src, error);
      throw error;
    });

  bufferCache.set(src, pending);
  return pending;
}

export function preloadWorldAmbience(context: BaseAudioContext, world: World) {
  for (const track of world.ambience) {
    void loadAudioBuffer(context, track.src).catch(() => {});
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
    track,
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
