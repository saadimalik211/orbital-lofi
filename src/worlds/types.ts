export type WorldId = "orbital-station" | "neon-city";

export type MusicStyle = {
  seed: number;
  bpm: number;
  rootMidi: number;
  swing: number;
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
  lightColor?: string;
};

export type StreakEvent = EventTiming & {
  type: "streak";
  angle?: number;
};

export type PulseEvent = EventTiming & {
  type: "pulse";
  pattern: "beacon" | "glitch" | "flash";
  color: string;
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

export interface World {
  id: WorldId;
  name: string;
  year: number;
  musicPrompt: string;
  music: MusicStyle;
  ambience: AmbienceTrack[];
  effects: WorldEffects;
  events: WorldEvent[];
}
