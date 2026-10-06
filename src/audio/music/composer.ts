import { createRng, type Rng } from "@/audio/music/random";
import {
  PROGRESSIONS,
  SCALES,
  chordName,
  chordSemitones,
  degreeToSemitones,
  noteIndex,
  voiceChord,
} from "@/audio/music/theory";
import type { MusicProfile, NoteName, ProgressionId, ScaleName } from "@/worlds/types";

export const BARS = 16;
export const STEPS_PER_BAR = 16;
const TOTAL_STEPS = BARS * STEPS_PER_BAR;

/** Pitched note; `step` is a 16th index into the loop, `length` is in 16ths. */
export type NoteEvent = { step: number; length: number; midi: number; velocity: number };
export type ChordEvent = { step: number; length: number; notes: number[]; velocity: number };
export type DrumHit = { step: number; kind: "kick" | "snare" | "hat"; velocity: number };

export type Composition = {
  seed: number;
  bpm: number;
  key: NoteName;
  scale: ScaleName;
  progression: ProgressionId;
  chordNames: string[];
  steps: number;
  swing: number;
  space: MusicProfile["space"];
  chords: ChordEvent[];
  bass: NoteEvent[];
  melody: NoteEvent[];
  drums: DrumHit[];
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** One chord per bar after progression + per-pass turnaround variation. */
function planHarmony(profile: MusicProfile, progression: readonly number[], rng: Rng) {
  const barsPerPass = progression.length * profile.chords.barsPerChord;
  // Second and fourth passes may swap their last chord for a turnaround (5th or 7th degree).
  const turnaround = rng.chance(0.5) ? rng.pick([4, 6]) : null;
  const degrees: number[] = [];
  for (let bar = 0; bar < BARS; bar += 1) {
    const pass = Math.floor(bar / barsPerPass);
    const slot = Math.floor((bar % barsPerPass) / profile.chords.barsPerChord);
    const isLast = slot === progression.length - 1;
    degrees.push(turnaround !== null && pass % 2 === 1 && isLast ? turnaround : progression[slot]);
  }
  return degrees;
}

function buildChords(
  profile: MusicProfile,
  scale: readonly number[],
  keyPc: number,
  barDegrees: number[],
  rng: Rng,
) {
  const events: ChordEvent[] = [];
  const pulseStep = rng.pick([10, 11, 14]);
  let previous: number[] | null = null;
  for (let bar = 0; bar < BARS; bar += 1) {
    const degree = barDegrees[bar];
    const changes = bar === 0 || degree !== barDegrees[bar - 1];
    const semis = chordSemitones(scale, degree, profile.chords.style);
    const voicing: number[] = changes || !previous ? voiceChord(semis.map((s) => (keyPc + s) % 12), previous) : previous;
    previous = voicing;
    const start = bar * STEPS_PER_BAR;

    if (profile.chords.rhythm === "pulse") {
      events.push({ step: start, length: 6, notes: voicing, velocity: 0.85 });
      events.push({ step: start + pulseStep, length: 3, notes: voicing, velocity: 0.55 });
    } else if (changes) {
      let bars = 1;
      while (bar + bars < BARS && barDegrees[bar + bars] === degree && bars < profile.chords.barsPerChord) {
        bars += 1;
      }
      events.push({ step: start, length: bars * STEPS_PER_BAR - 1, notes: voicing, velocity: 0.8 });
    }
  }
  return events;
}

type BassSlot = { step: number; length: number; tone: "root" | "fifth" | "third" | "octave" | "approach" };

const BASS_PATTERNS: readonly BassSlot[][] = [
  [{ step: 0, length: 12, tone: "root" }],
  [
    { step: 0, length: 6, tone: "root" },
    { step: 8, length: 6, tone: "fifth" },
  ],
  [
    { step: 0, length: 3, tone: "root" },
    { step: 6, length: 2, tone: "root" },
    { step: 8, length: 4, tone: "fifth" },
    { step: 14, length: 2, tone: "approach" },
  ],
  [
    { step: 0, length: 2, tone: "root" },
    { step: 3, length: 2, tone: "octave" },
    { step: 7, length: 2, tone: "third" },
    { step: 10, length: 3, tone: "fifth" },
    { step: 14, length: 2, tone: "approach" },
  ],
];

function bassRoot(keyPc: number, scale: readonly number[], degree: number) {
  const midi = 36 + ((keyPc + degreeToSemitones(scale, degree)) % 12);
  return midi > 43 ? midi - 12 : midi;
}

function buildBass(
  profile: MusicProfile,
  scale: readonly number[],
  keyPc: number,
  barDegrees: number[],
  rng: Rng,
) {
  const base = Math.min(BASS_PATTERNS.length - 1, Math.floor(clamp01(profile.density.bass) * BASS_PATTERNS.length));
  const pattern = BASS_PATTERNS[rng.chance(0.65) ? base : Math.max(0, base - 1)];
  const events: NoteEvent[] = [];
  for (let bar = 0; bar < BARS; bar += 1) {
    const degree = barDegrees[bar];
    const nextDegree = barDegrees[(bar + 1) % BARS];
    const root = bassRoot(keyPc, scale, degree);
    const chord = chordSemitones(scale, degree, "triad");
    for (const slot of pattern) {
      // Approach notes only lead into an actual chord change; otherwise hold the root.
      if (slot.tone === "approach" && nextDegree === degree) {
        continue;
      }
      const midi =
        slot.tone === "root" ? root
        : slot.tone === "octave" ? root + 12
        : slot.tone === "fifth" ? root + (chord[2] - chord[0])
        : slot.tone === "third" ? root + (chord[1] - chord[0])
        : bassRoot(keyPc, scale, nextDegree) - 1;
      events.push({
        step: bar * STEPS_PER_BAR + slot.step,
        length: slot.length,
        midi,
        velocity: slot.step === 0 ? 0.9 : 0.7,
      });
    }
  }
  return events;
}

function buildDrums(profile: MusicProfile, rng: Rng) {
  const density = clamp01(profile.density.drums);
  const kicks = new Set([0]);
  if (density >= 0.2) {
    kicks.add(rng.pick([8, 10]));
  }
  if (rng.chance(density * 0.7)) {
    kicks.add(rng.pick([3, 7, 11, 14]));
  }
  // Sparse styles use a half-time backbeat (snare on 3); busier ones play 2 and 4.
  const snares = density < 0.35 ? [8] : [4, 12];
  const ghost = density > 0.5 && rng.chance(0.6) ? rng.pick([7, 15]) : null;
  const hatEvery = density < 0.3 ? 4 : 2;
  const hatDrop = new Set(
    Array.from({ length: STEPS_PER_BAR }, (_, s) => s).filter(() => rng.chance(0.12)),
  );
  const hatPickup = density > 0.5 && rng.chance(0.5) ? rng.pick([13, 15]) : null;

  const hits: DrumHit[] = [];
  for (let bar = 0; bar < BARS; bar += 1) {
    const at = (step: number) => bar * STEPS_PER_BAR + step;
    const fill = bar % 8 === 7;
    for (const step of kicks) {
      if (!(fill && step > 8)) {
        hits.push({ step: at(step), kind: "kick", velocity: step === 0 ? 1 : 0.75 });
      }
    }
    for (const step of snares) {
      hits.push({ step: at(step), kind: "snare", velocity: 0.8 });
    }
    if (ghost !== null) {
      hits.push({ step: at(ghost), kind: "snare", velocity: 0.22 });
    }
    if (fill) {
      hits.push({ step: at(14), kind: "snare", velocity: 0.4 });
    }
    for (let step = 0; step < STEPS_PER_BAR; step += hatEvery) {
      if (!hatDrop.has(step)) {
        hits.push({ step: at(step), kind: "hat", velocity: step % 4 === 0 ? 0.55 : 0.35 });
      }
    }
    if (hatPickup !== null) {
      hits.push({ step: at(hatPickup), kind: "hat", velocity: 0.25 });
    }
  }
  return hits;
}

type Motif = { steps: number[]; lengths: number[]; contour: number[]; startTone: number };

function makeMotif(density: number, rng: Rng): Motif {
  const count = 2 + (density > 0.3 ? rng.int(1, 2) : rng.int(0, 1));
  const grid = [0, 2, 3, 4, 6, 7, 8, 10, 11, 12];
  const steps: number[] = [];
  while (steps.length < count) {
    const step = rng.pick(grid);
    if (!steps.includes(step)) {
      steps.push(step);
    }
  }
  steps.sort((a, b) => a - b);
  const lengths = steps.map((step, i) =>
    Math.max(1, Math.min((steps[i + 1] ?? step + rng.int(3, 6)) - step, 6)),
  );
  const contour = [0];
  for (let i = 1; i < count; i += 1) {
    const move = rng.chance(0.7) ? 1 : 2;
    contour.push(contour[i - 1] + (rng.chance(0.5) ? move : -move));
  }
  return { steps, lengths, contour, startTone: rng.pick([0, 1, 2]) };
}

function buildMelody(
  profile: MusicProfile,
  scale: readonly number[],
  keyPc: number,
  barDegrees: number[],
  rng: Rng,
) {
  const density = clamp01(profile.density.melody);
  const minorThird = scale[2] === 3;
  const allowed =
    profile.melodyScale === "pentatonic" ? (minorThird ? [0, 2, 3, 4, 6] : [0, 1, 2, 4, 5]) : [0, 1, 2, 3, 4, 5, 6];
  const snap = (degree: number) => {
    const octave = Math.floor(degree / 7);
    const within = ((degree % 7) + 7) % 7;
    const nearest = allowed.reduce((a, b) => (Math.abs(b - within) < Math.abs(a - within) ? b : a));
    return octave * 7 + nearest;
  };

  // One motif, repeated with light variation: sparse styles phrase every 8 bars, busier every 4 or 2.
  const motif = makeMotif(density, rng);
  const variant: Motif = { ...motif, contour: motif.contour.map((c, i, all) => (i === all.length - 1 ? c + (rng.chance(0.5) ? 1 : -1) : c)) };
  const every = density < 0.2 ? 8 : density < 0.4 ? 4 : 2;
  const offset = rng.int(0, Math.min(every, 4) - 1);

  const events: NoteEvent[] = [];
  let occurrence = 0;
  for (let bar = offset; bar < BARS; bar += every) {
    const current = occurrence % 4 === 2 || (every === 8 && occurrence === 1) ? variant : motif;
    occurrence += 1;
    const chordDegree = barDegrees[bar];
    const start = chordDegree + current.startTone * 2;
    const degrees = current.contour.map((c) => snap(start + c));
    // End on a chord tone so phrases resolve.
    const last = degrees.length - 1;
    const chordTones = [0, 2, 4].map((t) => chordDegree + t);
    degrees[last] = chordTones.reduce((a, b) => (Math.abs(b - degrees[last]) < Math.abs(a - degrees[last]) ? b : a));

    let shift = 0;
    const first = 60 + keyPc + degreeToSemitones(scale, degrees[0]);
    while (first + shift > 81) shift -= 12;
    while (first + shift < 67) shift += 12;

    degrees.forEach((degree, i) => {
      events.push({
        step: bar * STEPS_PER_BAR + current.steps[i],
        length: current.lengths[i],
        midi: 60 + keyPc + degreeToSemitones(scale, degree) + shift,
        velocity: i === 0 ? 0.75 : 0.6,
      });
    });
  }
  return events;
}

/** Deterministic: the same profile + seed always yields the same composition. */
export function compose(profile: MusicProfile, seed: number): Composition {
  const rng = createRng(seed);
  const bpm = rng.int(profile.tempo[0], profile.tempo[1]);
  const key = rng.pick(profile.keys);
  const keyPc = noteIndex(key);
  const scale = SCALES[profile.scale];
  const progression = rng.pick(profile.progressions);
  const barDegrees = planHarmony(profile, PROGRESSIONS[progression], rng);

  const chordNames = PROGRESSIONS[progression].map((degree) =>
    chordName(keyPc + degreeToSemitones(scale, degree), chordSemitones(scale, degree, profile.chords.style)),
  );

  return {
    seed,
    bpm,
    key,
    scale: profile.scale,
    progression,
    chordNames,
    steps: TOTAL_STEPS,
    swing: Math.min(0.3, Math.max(0, profile.swing)),
    space: profile.space,
    chords: buildChords(profile, scale, keyPc, barDegrees, rng),
    bass: buildBass(profile, scale, keyPc, barDegrees, rng),
    melody: buildMelody(profile, scale, keyPc, barDegrees, rng),
    drums: buildDrums(profile, rng),
  };
}

export function describeComposition(c: Composition) {
  return `seed=${c.seed} ${c.bpm}bpm ${c.key} ${c.scale} [${c.progression}] ${c.chordNames.join(" ")}`;
}
