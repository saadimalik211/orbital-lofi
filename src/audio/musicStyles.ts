export type MusicStyle = {
  seed: number;
  bpm: number;
  rootMidi: number;
  swing: number;
};

export const MUSIC_STYLES = {
  "orbital-station": {
    seed: 2187,
    bpm: 72,
    rootMidi: 57,
    swing: 0.58,
  },
  "neon-city": {
    seed: 2194,
    bpm: 78,
    rootMidi: 50,
    swing: 0.56,
  },
} as const satisfies Record<string, MusicStyle>;
