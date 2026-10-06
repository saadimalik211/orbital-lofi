export type WorldId = "orbital-station" | "neon-city";

/** Shader backdrops in `src/backdrops/shaders.ts`. Worlds may share one. */
export type SceneBackdropId = "planet-orbit" | "neon-skyline";

export type Rgb = readonly [number, number, number];

/** What sits behind effects, events and the HUD. Media `src` lives in `public/worlds/<world-id>/scene/`. */
export type SceneConfig =
  | { type: "shader"; backdrop: SceneBackdropId }
  | { type: "image"; src: string }
  | { type: "video"; src: string; poster?: string };

export type SceneType = SceneConfig["type"];

export type NoteName =
  | "C" | "C#" | "D" | "Eb" | "E" | "F" | "F#" | "G" | "Ab" | "A" | "Bb" | "B";

/** Seven-note modes; intervals live in `src/audio/music/theory.ts`. */
export type ScaleName = "major" | "lydian" | "mixolydian" | "dorian" | "aeolian";

/** Scale-degree progressions (1-based), resolved against the composition's key + scale. */
export type ProgressionId =
  | "1-4-1-4"
  | "1-6-2-5"
  | "2-5-1-6"
  | "4-3-2-1"
  | "1-6-3-7"
  | "1-4-7-3"
  | "1-7-6-7"
  | "1-4-5-1";

/**
 * One section of the song form. All sections share key, motif and groove; `a` sections share
 * the main progression, `b` uses a second one. Layer levels (0–1) scale the profile `density`,
 * 0 silences the layer. For drums the level also sets what plays: below 0.5 hats only, below
 * 0.75 kick/snare/hats, 0.75+ the full groove, 0.95+ adds pickups and open hats.
 */
export type MusicSection = {
  kind: "intro" | "a" | "b" | "breakdown";
  /** Ideally a multiple of one progression pass (4 × `barsPerChord`). */
  bars: number;
  drums: number;
  bass: number;
  melody: number;
  /** Repeat with seeded changes: alternate chord inversion, motif variant, turnaround. */
  variation?: boolean;
  /** Multiplies `space.brightness` (e.g. 0.5 for a filtered intro). Default 1. */
  tone?: number;
  /** Multiplies `space.reverb`. Default 1. */
  wet?: number;
};

/** Procedural music style. Every composition is `compose(profile, seed)`. All 0–1 values unless noted. */
export type MusicProfile = {
  /** Inclusive BPM range; each seed picks one. */
  tempo: readonly [number, number];
  /** Candidate keys; each seed picks one. */
  keys: readonly [NoteName, ...NoteName[]];
  scale: ScaleName;
  /** Candidate progressions; each seed picks one. */
  progressions: readonly [ProgressionId, ...ProgressionId[]];
  chords: {
    /** triad = 3 notes, seventh = 4, ninth = root/3rd/7th/9th. */
    style: "triad" | "seventh" | "ninth";
    /** sustain = one long chord per change; pulse = syncopated restrikes every bar. */
    rhythm: "sustain" | "pulse";
    barsPerChord: 1 | 2;
  };
  /** Peak busyness of each layer; sections scale it down. */
  density: { drums: number; bass: number; melody: number };
  /** pentatonic keeps the melody on the 5 most consonant scale degrees. */
  melodyScale: "full" | "pentatonic";
  /** reverb = wet send; brightness = low-pass openness; softness = slower attacks. */
  space: { reverb: number; brightness: number; softness: number };
  /** Song form, played in order and then looped. */
  form: readonly [MusicSection, ...MusicSection[]];
  groove?: {
    /** Delay of off-beat 16ths, as a fraction of a 16th (0–0.3). Default 0. */
    swing?: number;
    /** Max seeded lateness of off-downbeat notes, in seconds (0–0.03). Default 0.004. */
    timingHumanization?: number;
    /** Max seeded gain deviation, as a fraction (0–0.3). Default 0.05. */
    velocityHumanization?: number;
  };
  /** Tape wow/flutter amount on the music bus (0–1; 0.3 ≈ 1.5 cents). Default 0. */
  tape?: number;
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
  music: MusicProfile;
  ambience: AmbienceTrack[];
  effects: WorldEffects;
  events: WorldEvent[];
};
