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
import type { MusicProfile, MusicSection, NoteName, ProgressionId, ScaleName } from "@/worlds/types";

export const STEPS_PER_BAR = 16;

/**
 * `step` is a 16th index into the whole piece and `length` is in 16ths. `nudge` is a seeded
 * lateness in seconds, applied on top of the grid so it can never accumulate into drift.
 */
export type NoteEvent = { step: number; length: number; midi: number; velocity: number; nudge: number };
export type ChordEvent = {
  step: number;
  length: number;
  velocity: number;
  nudge: number;
  /** Ascending MIDI notes, each with an onset delay (seconds) and a relative level. */
  notes: number[];
  delays: number[];
  levels: number[];
  /** Release-length multiplier. */
  release: number;
};
export type DrumHit = {
  step: number;
  kind: "kick" | "snare" | "hat" | "openHat";
  velocity: number;
  nudge: number;
};
/** Where a section starts, with its filter/reverb multipliers for the engine. */
export type SectionMark = { kind: MusicSection["kind"]; step: number; tone: number; wet: number };

export type Composition = {
  seed: number;
  bpm: number;
  key: NoteName;
  scale: ScaleName;
  progression: ProgressionId;
  /** Progression of `b` sections. */
  bridge: ProgressionId;
  chordNames: string[];
  form: string;
  steps: number;
  swing: number;
  tape: { depth: number; wowRate: number; flutterRate: number };
  space: MusicProfile["space"];
  /** Copied from the profile. Not drawn from the composition random stream. */
  reverb: MusicProfile["reverb"];
  sound: MusicProfile["sound"];
  sections: SectionMark[];
  chords: ChordEvent[];
  bass: NoteEvent[];
  melody: NoteEvent[];
  drums: DrumHit[];
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);

/** Humanization draws from its own seeded stream, so tuning it never changes the notes. */
type Feel = { rng: Rng; timing: number; velocity: number };

function humanize(feel: Feel, velocity: number, amount = 1) {
  return clamp(velocity * (1 + (feel.rng.next() * 2 - 1) * feel.velocity * amount), 0.05, 1.2);
}

/** Bar downbeats stay exactly on the grid; everything else may sit a few ms late. */
function lateness(feel: Feel, step: number, amount = 1) {
  return step % STEPS_PER_BAR === 0 ? 0 : feel.rng.next() * feel.timing * amount;
}

type PlannedSection = MusicSection & { startBar: number; degrees: number[]; next: MusicSection };

/** Lays out the form: one chord degree per bar, `b` on the bridge progression. */
function planForm(profile: MusicProfile, main: readonly number[], bridge: readonly number[], rng: Rng) {
  const per = profile.chords.barsPerChord;
  // Variation sections may end their last pass on a turnaround (5th or 7th degree) instead.
  const turnaround = rng.chance(0.6) ? rng.pick([4, 6]) : null;
  let startBar = 0;
  return profile.form.map((section, index): PlannedSection => {
    const progression = section.kind === "b" ? bridge : main;
    const pass = progression.length * per;
    const bars = Math.max(1, Math.round(section.bars));
    const degrees = Array.from({ length: bars }, (_, bar) => {
      const slot = Math.floor((bar % pass) / per) % progression.length;
      const finalPass = bar >= bars - pass;
      const swap = section.variation && turnaround !== null && finalPass && slot === progression.length - 1;
      return swap ? turnaround : progression[slot];
    });
    const planned = { ...section, bars, startBar, degrees, next: profile.form[(index + 1) % profile.form.length] };
    startBar += bars;
    return planned;
  });
}

function buildChords(
  profile: MusicProfile,
  scale: readonly number[],
  keyPc: number,
  sections: PlannedSection[],
  rng: Rng,
  feel: Feel,
) {
  const events: ChordEvent[] = [];
  const pulse = profile.chords.rhythm === "pulse";
  const pulseStep = rng.pick([10, 11, 14]);
  const strum = 0.005 + rng.next() * 0.008;
  const softness = clamp01(profile.space.softness);
  let previous: number[] | null = null;

  const emit = (
    step: number,
    length: number,
    velocity: number,
    voicing: number[],
    { spread, rootPc, omitRoot, reshape }: { spread: number; rootPc: number; omitRoot: boolean; reshape: boolean },
  ) => {
    let notes = omitRoot ? voicing.filter((note) => note % 12 !== rootPc) : [...voicing];
    if (reshape) {
      // Open up a section's last chord without moving any voice: add the root on top, or
      // thin the bottom when there is no room above.
      const top = notes[notes.length - 1];
      const rootAbove = top + 1 + ((((rootPc - top - 1) % 12) + 12) % 12);
      notes = rootAbove <= 79 && rootAbove - top <= 7 ? [...notes, rootAbove] : notes.slice(1);
    }
    events.push({
      step,
      length,
      velocity: humanize(feel, velocity, 0.5),
      nudge: lateness(feel, step, 0.5),
      notes,
      delays: notes.map((_, i) => i * spread),
      levels: notes.map((_, i) => humanize(feel, i === notes.length - 1 ? 1.06 : 1, 0.7)),
      release: 0.85 + feel.rng.next() * 0.35,
    });
  };

  for (const section of sections) {
    const soft = section.kind === "intro" ? 0.85 : 1;
    const arpeggioSection = section.kind === "intro" || section.kind === "breakdown";
    for (let bar = 0; bar < section.bars; bar += 1) {
      const degree = section.degrees[bar];
      const changes = bar === 0 || degree !== section.degrees[bar - 1];
      let voicing: number[] = previous ?? [];
      if (changes || !previous) {
        const pcs = chordSemitones(scale, degree, profile.chords.style).map((s) => (keyPc + s) % 12);
        const nearest = voiceChord(pcs, previous);
        // Variations open on the next-closest inversion, so a repeat sounds re-voiced.
        const alternate = section.variation && bar === 0 ? voiceChord(pcs, previous, nearest) : [];
        voicing = alternate.length > 0 ? alternate : nearest;
      }
      previous = voicing;

      const start = (section.startBar + bar) * STEPS_PER_BAR;
      const rootPc = (keyPc + degreeToSemitones(scale, degree)) % 12;
      // Rootless restrikes are fine when the bass is holding the root.
      const omit = (chance: number) => voicing.length >= 4 && section.bass > 0 && rng.chance(chance);
      const lastBar = bar === section.bars - 1;
      const reshape = lastBar && rng.chance(0.4);

      if (pulse) {
        emit(start, 6, 0.85 * soft, voicing, { spread: strum, rootPc, omitRoot: false, reshape: false });
        if (!rng.chance(0.1)) {
          emit(start + pulseStep, 3, 0.55 * soft, voicing, { spread: strum * 0.5, rootPc, omitRoot: omit(0.3), reshape });
        }
      } else if (changes) {
        let bars = 1;
        while (
          bar + bars < section.bars &&
          section.degrees[bar + bars] === degree &&
          bars < profile.chords.barsPerChord
        ) {
          bars += 1;
        }
        const arpeggio = arpeggioSection && rng.chance(0.4 + softness * 0.4);
        emit(start, bars * STEPS_PER_BAR - 1, 0.8 * soft, voicing, {
          spread: arpeggio ? 0.045 + rng.next() * 0.045 : strum,
          rootPc,
          omitRoot: omit(0.15),
          reshape: bar + bars >= section.bars && reshape,
        });
      }
    }
  }
  return events;
}

type BassTone = "root" | "fifth" | "third" | "octave" | "approach";
type BassSlot = { step: number; length: number; tone: BassTone };

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
  sections: PlannedSection[],
  rng: Rng,
  feel: Feel,
) {
  const degreeAt = sections.flatMap((section) => section.degrees);
  const bias = rng.chance(0.65) ? 0 : -1;
  const events: NoteEvent[] = [];

  for (const section of sections) {
    if (section.bass <= 0) {
      continue;
    }
    const level = clamp01(profile.density.bass) * clamp01(section.bass);
    const pattern =
      BASS_PATTERNS[clamp(Math.floor(level * BASS_PATTERNS.length) + bias, 0, BASS_PATTERNS.length - 1)];
    const hasApproach = pattern.some((slot) => slot.tone === "approach");
    const alteredBar = section.variation ? rng.int(1, Math.max(1, section.bars - 1)) : -1;

    for (let bar = 0; bar < section.bars; bar += 1) {
      const absBar = section.startBar + bar;
      const degree = degreeAt[absBar];
      const nextDegree = degreeAt[(absBar + 1) % degreeAt.length];
      const root = bassRoot(keyPc, scale, degree);
      const triad = chordSemitones(scale, degree, "triad");
      const changes = nextDegree !== degree;
      const lastBar = bar === section.bars - 1;

      const slots = [...pattern];
      // Sparse patterns still lead into some chord changes with a single approach note.
      if (!hasApproach && changes && rng.chance(0.25)) {
        slots.push({ step: 14, length: 2, tone: "approach" });
      }
      // One altered note per variation section keeps repeats from being literal copies.
      if (bar === alteredBar) {
        const fifth = slots.findIndex((slot) => slot.tone === "fifth");
        if (fifth >= 0) {
          slots[fifth] = { ...slots[fifth], tone: "octave" };
        } else {
          slots[0] = { ...slots[0], length: Math.min(slots[0].length, 8) };
          slots.push({ step: 10, length: 4, tone: "fifth" });
        }
      }
      const rest = slots.length > 1 && rng.chance(0.12) ? rng.int(1, slots.length - 1) : -1;
      // Hand off cleanly when the next section drops the bass.
      const tailRest = lastBar && section.next.bass <= 0;

      slots.forEach((slot, i) => {
        if ((slot.tone === "approach" && !changes) || i === rest || (tailRest && slot.step >= 8)) {
          return;
        }
        let midi = root;
        if (slot.tone === "octave") {
          midi = root + 12;
        } else if (slot.tone === "fifth") {
          midi = root + (triad[2] - triad[0]);
        } else if (slot.tone === "third") {
          midi = root + (triad[1] - triad[0]);
        } else if (slot.tone === "approach") {
          // Diatonic step below the next root.
          const stepDown = degreeToSemitones(scale, nextDegree) - degreeToSemitones(scale, nextDegree - 1);
          midi = bassRoot(keyPc, scale, nextDegree) - stepDown;
        }
        events.push({
          step: absBar * STEPS_PER_BAR + slot.step,
          length: slot.length,
          midi,
          velocity: humanize(feel, slot.step === 0 ? 0.9 : 0.7),
          nudge: lateness(feel, slot.step, 0.6),
        });
      });
    }
  }
  return events;
}

function buildDrums(profile: MusicProfile, sections: PlannedSection[], rng: Rng, feel: Feel) {
  const density = clamp01(profile.density.drums);
  // One groove for the whole piece; sections only decide how much of it plays.
  const groove = {
    kickB: rng.pick([8, 10]),
    kickExtra: rng.chance(density * 0.7) ? rng.pick([3, 7, 11, 14]) : null,
    ghostSnare: rng.pick([7, 15]),
    ghostKick: rng.pick([6, 13, 15]),
    hatPickup: rng.pick([13, 15]),
    openHat: rng.pick([6, 14]),
    hatDrop: new Set(Array.from({ length: STEPS_PER_BAR }, (_, s) => s).filter(() => rng.chance(0.12))),
  };
  const snares = density < 0.35 ? [8] : [4, 12];
  const hits: DrumHit[] = [];

  for (const section of sections) {
    const level = clamp01(section.drums);
    if (level <= 0) {
      continue;
    }
    const core = level >= 0.5;
    const full = level >= 0.75;
    const extras = level >= 0.95;
    const hatEvery = density >= 0.3 || (extras && density >= 0.2) ? 2 : 4;
    const hatLevel = 0.6 + 0.4 * level;

    for (let bar = 0; bar < section.bars; bar += 1) {
      const base = (section.startBar + bar) * STEPS_PER_BAR;
      const add = (step: number, kind: DrumHit["kind"], velocity: number, tight: boolean) => {
        hits.push({
          step: base + step,
          kind,
          velocity: humanize(feel, velocity, tight ? 0.3 : 1),
          nudge: lateness(feel, step, tight ? 0.3 : 1),
        });
      };
      const fill = core && bar === section.bars - 1 && rng.chance(0.6);

      if (core) {
        const kicks = [0];
        if (full && density >= 0.2) {
          kicks.push(groove.kickB);
        }
        if (full && groove.kickExtra !== null) {
          kicks.push(groove.kickExtra);
        }
        const skipped = kicks.length > 1 && rng.chance(0.08) ? rng.pick(kicks.slice(1)) : null;
        for (const step of kicks) {
          if (step !== skipped && !(fill && step > 8)) {
            add(step, "kick", step === 0 ? 1 : 0.75, true);
          }
        }
        if (extras && density > 0.45 && rng.chance(0.2)) {
          add(groove.ghostKick, "kick", 0.35, true);
        }
        for (const step of snares) {
          add(step, "snare", 0.8, true);
        }
        if (full && density > 0.5) {
          add(groove.ghostSnare, "snare", 0.22, false);
        }
        if (fill) {
          add(14, "snare", 0.4, false);
          if (density > 0.5) {
            add(15, "snare", 0.25, false);
          }
        }
      }

      const toggled = rng.chance(0.08) ? rng.int(1, STEPS_PER_BAR - 1) : -1;
      const openAt = extras && density >= 0.4 && bar % 2 === 1 ? groove.openHat : -1;
      const pickupAt = extras && density > 0.5 && bar % 2 === 1 ? groove.hatPickup : -1;
      for (let step = 0; step < STEPS_PER_BAR; step += 1) {
        const onGrid = step % hatEvery === 0 && !groove.hatDrop.has(step);
        if (step === openAt) {
          add(step, "openHat", 0.5 * hatLevel, false);
        } else if (onGrid !== (step === toggled)) {
          add(step, "hat", (step % 4 === 0 ? 0.55 : onGrid ? 0.35 : 0.22) * hatLevel, false);
        } else if (step === pickupAt) {
          add(step, "hat", 0.25 * hatLevel, false);
        }
      }
    }
  }
  return hits;
}

type Motif = { steps: number[]; lengths: number[]; contour: number[]; startTone: number };

/** 2–4 notes on 8th-ish positions, stepwise contour that tends to fall at the end. */
function makeMotif(density: number, rng: Rng): Motif {
  const count = 2 + (density > 0.3 ? rng.int(1, 2) : rng.int(0, 1));
  const steps = [rng.pick([0, 2, 4])];
  while (steps.length < count && steps[steps.length - 1] + 2 <= 12) {
    steps.push(steps[steps.length - 1] + rng.pick([2, 2, 3, 4]));
  }
  const lengths = steps.map((step, i) =>
    i < steps.length - 1 ? Math.min(steps[i + 1] - step, 4) : rng.int(4, 8),
  );
  const contour = [0];
  for (let i = 1; i < steps.length; i += 1) {
    const move = rng.chance(0.75) ? 1 : 2;
    const falling = i >= steps.length / 2 ? rng.chance(0.65) : rng.chance(0.4);
    contour.push(contour[i - 1] + (falling ? -move : move));
  }
  return { steps, lengths, contour, startTone: rng.pick([0, 1, 2]) };
}

/** Same rhythm, last interval nudged and the final note held a little longer. */
function varyMotif(motif: Motif, rng: Rng): Motif {
  const last = motif.contour.length - 1;
  return {
    ...motif,
    contour: motif.contour.map((c, i) => (i === last && last > 0 ? c + (rng.chance(0.5) ? 1 : -1) : c)),
    lengths: motif.lengths.map((l, i) => (i === last ? Math.min(l + 2, 8) : l)),
  };
}

function buildMelody(
  profile: MusicProfile,
  scale: readonly number[],
  keyPc: number,
  sections: PlannedSection[],
  rng: Rng,
  feel: Feel,
) {
  const peak = clamp01(profile.density.melody);
  const minorThird = scale[2] === 3;
  const allowed =
    profile.melodyScale === "pentatonic" ? (minorThird ? [0, 2, 3, 4, 6] : [0, 1, 2, 4, 5]) : [0, 1, 2, 3, 4, 5, 6];
  const snap = (degree: number) => {
    const octave = Math.floor(degree / 7);
    const within = ((degree % 7) + 7) % 7;
    const nearest = allowed.reduce((a, b) => (Math.abs(b - within) < Math.abs(a - within) ? b : a));
    return octave * 7 + nearest;
  };
  const toMidi = (degree: number) => 60 + keyPc + degreeToSemitones(scale, degree);

  // One core motif for the piece; `b` answers it from a different chord tone.
  const motif = makeMotif(peak, rng);
  const answer = { ...motif, startTone: (motif.startTone + 1) % 3 };
  const variants = new Map([
    [motif, varyMotif(motif, rng)],
    [answer, varyMotif(answer, rng)],
  ]);
  const offsetSeed = rng.int(0, 2);

  const events: NoteEvent[] = [];
  let placed = 0;
  for (const section of sections) {
    const level = peak * clamp01(section.melody);
    if (level <= 0) {
      continue;
    }
    // Sparse: one phrase per 8, 4 or 2 bars, never on a section's first bar.
    const every = level < 0.2 ? 8 : level < 0.4 ? 4 : 2;
    const offset = 1 + (offsetSeed % Math.min(every - 1, 3));
    let occurrence = 0;
    for (let bar = offset; bar < section.bars; bar += every) {
      const k = occurrence;
      occurrence += 1;
      // Skip the odd phrase (never the first), or push it a 16th or two late.
      if (placed > 0 && rng.chance(0.12)) {
        continue;
      }
      const delay = rng.chance(0.15) ? rng.pick([1, 2]) : 0;
      const base = section.kind === "b" ? answer : motif;
      const shape = k % 4 === 2 || (section.variation && k === 0) ? variants.get(base)! : base;

      const chordDegree = section.degrees[bar];
      const degrees = shape.contour.map((c) => snap(chordDegree + shape.startTone * 2 + c));
      // Resolve on the chord's root or third, whichever is nearest.
      const last = degrees.length - 1;
      const targets = [-7, -5, 0, 2, 7, 9].map((t) => chordDegree + t);
      degrees[last] = targets.reduce((a, b) => (Math.abs(b - degrees[last]) < Math.abs(a - degrees[last]) ? b : a));

      // Centre the phrase near G4–A4 and keep it under G5, so high notes stay rare.
      const pitches = degrees.map(toMidi);
      const low = Math.min(...pitches);
      const high = Math.max(...pitches);
      const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
      const shifts = [-24, -12, 0, 12, 24].filter((s) => high + s <= 79 && low + s >= 60);
      const shift = (shifts.length > 0 ? shifts : [-24]).reduce(
        (a, b) => (Math.abs(mean + b - 70) < Math.abs(mean + a - 70) ? b : a),
      );

      // Merge repeated pitches into one longer note instead of re-striking.
      const notes: { step: number; length: number; midi: number }[] = [];
      shape.steps.forEach((step, i) => {
        const midi = pitches[i] + shift;
        const prev = notes[notes.length - 1];
        if (prev && prev.midi === midi) {
          prev.length = step + shape.lengths[i] - prev.step;
        } else {
          notes.push({ step, length: shape.lengths[i], midi });
        }
      });
      const tail = notes[notes.length - 1];
      if (rng.chance(0.15)) {
        tail.length = Math.min(tail.length + 2, 10);
      } else if (rng.chance(0.1) && tail.length > 3) {
        tail.length -= 1;
      }

      const barStart = (section.startBar + bar) * STEPS_PER_BAR + delay;
      notes.forEach((note, i) => {
        events.push({
          step: barStart + note.step,
          length: note.length,
          midi: note.midi,
          velocity: humanize(feel, i === 0 ? 0.72 : i === notes.length - 1 ? 0.55 : 0.6),
          nudge: lateness(feel, delay + note.step),
        });
      });
      placed += 1;
    }
  }
  return events;
}

const SECTION_LABEL: Record<MusicSection["kind"], string> = { intro: "intro", a: "A", b: "B", breakdown: "brk" };

/** Deterministic: the same profile + seed always yields the same composition. */
export function compose(profile: MusicProfile, seed: number): Composition {
  const rng = createRng(seed);
  const groove = profile.groove ?? {};
  const feel: Feel = {
    rng: createRng(seed ^ 0x5bd1e995),
    timing: clamp(groove.timingHumanization ?? 0.004, 0, 0.03),
    velocity: clamp(groove.velocityHumanization ?? 0.05, 0, 0.3),
  };

  const bpm = rng.int(profile.tempo[0], profile.tempo[1]);
  const key = rng.pick(profile.keys);
  const keyPc = noteIndex(key);
  const scale = SCALES[profile.scale];
  const progression = rng.pick(profile.progressions);
  const others = profile.progressions.filter((p) => p !== progression);
  const bridge = others.length > 0 ? rng.pick(others) : progression;
  const sections = planForm(profile, PROGRESSIONS[progression], PROGRESSIONS[bridge], rng);

  const chords = buildChords(profile, scale, keyPc, sections, rng, feel);
  const bass = buildBass(profile, scale, keyPc, sections, rng, feel);
  const melody = buildMelody(profile, scale, keyPc, sections, rng, feel);
  const drums = buildDrums(profile, sections, rng, feel);
  const tape = { depth: clamp01(profile.tape ?? 0), wowRate: 0.35 + rng.next() * 0.4, flutterRate: 4.5 + rng.next() * 2.5 };

  const chordNames = PROGRESSIONS[progression].map((degree) =>
    chordName(keyPc + degreeToSemitones(scale, degree), chordSemitones(scale, degree, profile.chords.style)),
  );
  const totalBars = sections.reduce((sum, section) => sum + section.bars, 0);

  return {
    seed,
    bpm,
    key,
    scale: profile.scale,
    progression,
    bridge,
    chordNames,
    form: sections.map((s) => SECTION_LABEL[s.kind] + (s.variation ? "'" : "")).join(" "),
    steps: totalBars * STEPS_PER_BAR,
    swing: clamp(groove.swing ?? 0, 0, 0.3),
    tape,
    space: profile.space,
    reverb: profile.reverb,
    sound: profile.sound,
    sections: sections.map((s) => ({
      kind: s.kind,
      step: s.startBar * STEPS_PER_BAR,
      tone: clamp(s.tone ?? 1, 0.2, 1.5),
      wet: clamp(s.wet ?? 1, 0, 2),
    })),
    chords,
    bass,
    melody,
    drums,
  };
}

export function describeComposition(c: Composition) {
  const bars = c.steps / STEPS_PER_BAR;
  return `seed=${c.seed} ${c.bpm}bpm ${c.key} ${c.scale} [${c.progression} | B ${c.bridge}] ${c.chordNames.join(" ")} · ${bars} bars: ${c.form}`;
}
