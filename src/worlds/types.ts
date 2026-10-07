export type WorldId = "orbital-station" | "neon-city" | "centauri-a";

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
 * One section of the song form. All sections share key, motif and the piece's groove; `a`
 * sections share the main progression, `b` uses a second one. Layer levels (0–1) scale the
 * profile `density`, 0 silences the layer. For drums, below 0.5 is hats only, below 0.75 is
 * the groove's kick and snare, and 0.75+ adds that groove's extra kicks. Open hats and
 * pickups, when the groove has them, arrive at 0.95 on busier profiles.
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
  /** Multiplies `reverb.amount`. Default 1. */
  wet?: number;
};

/**
 * Generated room. Decay, damping, and pre-delay shape the early taps and the tail.
 * The engine builds both; there is no sample file.
 */
export type MusicReverb = {
  /** Wet send, 0–1. Sections scale it with `wet`. */
  amount: number;
  /** Tail length in seconds (about 0.4–4). Also spreads the early taps slightly. */
  decay: number;
  /** 0 = brighter return, 1 = darker. Highs fade first. */
  damping: number;
  /** Silence before the first reflection, in seconds (0–0.08). */
  preDelay?: number;
};

/** Timbre. 0–1. The engine never branches on which world is playing. */
export type MusicSound = {
  /** 1 = soft body, almost no click. 0 = a clearer short transient. */
  kickSoftness: number;
  /** Higher is a bit brighter, still a soft snare. */
  snareBrightness: number;
  /** Higher opens the hat filter a little. */
  hatBrightness: number;
  /** 1 = sine-heavy mellow keys. 0 = a little more harmonic edge. */
  chordWarmth: number;
  /** How far the lead filter opens. */
  leadBrightness: number;
  /** Octave harmonic on the bass, for speakers that miss the fundamental. 0 is almost none. */
  bassPresence: number;
  /** Very quiet noise bed under the music. Even 1 stays in the background. */
  textureAmount: number;
};

/** Procedural music style. Every composition is `compose(profile, seed)`. All 0–1 values unless noted. */
export type MusicProfile = {
  /** Offline generation prompt. The text lives in `musicPrompts.json`. Playback does not read this. */
  prompt: string;
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
  /** brightness = low-pass openness; softness = slower attacks. */
  space: { brightness: number; softness: number };
  reverb: MusicReverb;
  sound: MusicSound;
  /**
   * Where a manual Next begins. `"main"` skips to the first A section so the intro
   * isn't replayed on every press. Playback and world changes still start at the intro.
   */
  nextStartMode?: "intro" | "main";
  /** Song form, played in order and then looped. Chosen more often than `forms`. */
  form: readonly [MusicSection, ...MusicSection[]];
  /**
   * Alternate arrangements in the same length range. Each seed picks one form.
   * Omit it and every seed uses `form`.
   */
  forms?: readonly (readonly [MusicSection, ...MusicSection[]])[];
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

/** A shipped AI recording. Playback loads the file; it never generates one. */
export type AiMusicTrack = {
  id: string;
  src: string;
  /** Optional label. The HUD keeps the procedural signal unless these are wired up later. */
  metadata?: {
    bpm?: number;
    key?: string;
    mode?: string;
  };
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
  /** `color` tints both haze gradients. Intensity still sets the layer opacity. */
  fog?: { intensity: number; color: Rgb };
  /** `color` tints `atmosphere` specks. Dust and snow keep their own colors. */
  particles?: { type: ParticleKind; intensity: number; color?: Rgb };
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
  /** Pre-generated tracks. Omit it, or leave it empty, and the world stays procedural. */
  aiMusic?: readonly AiMusicTrack[];
  ambience: AmbienceTrack[];
  effects: WorldEffects;
  events: WorldEvent[];
};
