export type WorldId = "orbital-station" | "neon-city";

/** Shader backdrops in `src/backdrops/shaders.ts`. Worlds may share one. */
export type SceneBackdropId = "planet-orbit" | "neon-skyline";

export type Rgb = readonly [number, number, number];

export type SceneConfig = {
  backdrop: SceneBackdropId;
};

export type MusicBed = {
  seed: number;
  bpm: number;
  rootMidi: number;
  swing: number;
  /** 0–1: low-pass cutoff and chord voicing brightness. */
  brightness: number;
  /** 0–1: vinyl crackle level. */
  texture: number;
};

export type WorldMusic = {
  /** MusicGen text prompt for the generated clip. */
  prompt: string;
  /** Procedural bed that plays instantly while the clip renders. */
  bed: MusicBed;
};

export type AmbienceTrack = {
  id: string;
  name: string;
  src: string;
  defaultVolume: number;
};

export type ParticleKind = "dust" | "snow" | "atmosphere";

export type FlickerStyle = "screen" | "neon";

export type WorldEffects = {
  rain?: { intensity: number };
  fog?: { intensity: number };
  particles?: { type: ParticleKind; intensity: number };
  stars?: { intensity: number };
  flicker?: { intensity: number; style?: FlickerStyle };
};

export type EventSound = {
  src: string;
  volume?: number;
};

type EventTiming = {
  id: string;
  weight: number;
  minDelay: number;
  maxDelay: number;
  cooldown?: number;
  duration?: number;
  sound?: EventSound;
};

export type FlybyEvent = EventTiming & {
  type: "flyby";
  asset?: string;
  direction?: "ltr" | "rtl" | "either";
  top?: [number, number];
  scale?: number;
  lightColor?: Rgb;
};

export type StreakEvent = EventTiming & {
  type: "streak";
  angle?: number;
};

export type PulseEvent = EventTiming & {
  type: "pulse";
  pattern: "beacon" | "glitch" | "flash";
  color: Rgb;
  x: number;
  y: number;
  size?: number;
  intensity: number;
};

export type SoundEvent = EventTiming & {
  type: "sound";
  sound: EventSound;
};

export type WorldEvent = FlybyEvent | StreakEvent | PulseEvent | SoundEvent;

export type WorldEventType = WorldEvent["type"];

export type World = {
  id: WorldId;
  name: string;
  year: number;
  scene: SceneConfig;
  music: WorldMusic;
  ambience: AmbienceTrack[];
  effects: WorldEffects;
  events: WorldEvent[];
};
