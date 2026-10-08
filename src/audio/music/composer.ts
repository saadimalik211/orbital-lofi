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
import type {
  MusicProfile,
  MusicSection,
  NoteName,
  ProgressionId,
  ScaleName,
  TransitionCharacter,
} from "@/worlds/types";

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
/** One gesture at a section boundary. Chosen from its own seed, after the arrangement exists. */
export type TransitionId =
  | "hold"
  | "bass-rest"
  | "hat-pickup"
  | "hat-fill"
  | "ghost"
  | "drum-rest"
  | "bass-pickup"
  | "lead-pickup";
export type TransitionMark = { step: number; kind: TransitionId };
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
  arrangement: {
    groove: GrooveId;
    bass: BassId;
    voicing: "close" | "open";
    harmonic: HarmonicId;
    melody: { motif: MotifId; rhythm: MelodicRhythm; contour: MelodicContour; register: MelodicRegister };
    color: ColorPlan;
  };
  /** Color of each chord event, in the same order as `chords`. */
  chordColors: ChordColorId[];
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
  /** Boundary gestures. Empty when the profile has no `transitions` block. */
  transitions: TransitionMark[];
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

type PlannedSection = MusicSection & {
  startBar: number;
  degrees: number[];
  /** Second chord in the bar, starting on beat 3. Null keeps one chord for the bar. */
  splits: (number | null)[];
  next: MusicSection;
};

export type HarmonicId = "long" | "mixed" | "balanced" | "pulsed";
export type ChordColorId = "plain" | "add9" | "sus2" | "sus4" | "six" | "six9" | "open" | "relative";
export type HarmonicCharacter = "floating" | "nocturnal" | "modal";
export type ColorPlan = {
  character: HarmonicCharacter;
  primary: ChordColorId;
  secondary: ChordColorId;
  accent: ChordColorId;
  substitution: "none" | "sus" | "relative";
};
export type MotifId = "descend" | "held" | "repeat" | "neighbor" | "leap" | "call" | "pickup";
export type MelodicRhythm = "long-short" | "short-rest" | "even-resolve" | "sustain" | "sparse" | "sync";
export type MelodicContour = "down" | "up" | "arch" | "valley" | "repeat" | "leap" | "neighbor";
export type MelodicRegister = "low" | "mid" | "high";

export type GrooveId = "sparse" | "halftime" | "kick-light" | "backbeat" | "syncopated";
export type BassId = "anchor" | "held" | "fifth" | "sync" | "approach" | "octave";

/** Home form is listed twice so the world's main arrangement stays the most common. */
function pickForm(profile: MusicProfile, rng: Rng) {
  const forms = [profile.form, ...(profile.forms ?? [])];
  const roll = rng.int(0, forms.length);
  const index = roll === 0 ? 0 : roll - 1;
  return forms[index];
}

function groovePool(density: number): GrooveId[] {
  if (density < 0.4) {
    return ["sparse", "halftime", "kick-light"];
  }
  return ["backbeat", "syncopated", "sparse", "kick-light"];
}

function bassPool(density: number): BassId[] {
  if (density < 0.28) {
    return ["anchor", "held"];
  }
  if (density < 0.5) {
    return ["anchor", "fifth", "held"];
  }
  return ["fifth", "sync", "approach", "octave"];
}

const CALM_BASS = new Set<BassId>(["anchor", "held", "fifth", "octave"]);

function busyGroove(groove: GrooveId) {
  return groove === "backbeat" || groove === "syncopated";
}

/** Lays out the form: one chord degree per bar, `b` on the bridge progression. */
function planForm(
  profile: MusicProfile,
  main: readonly number[],
  bridge: readonly number[],
  form: readonly MusicSection[],
  rng: Rng,
) {
  const per = profile.chords.barsPerChord;
  // Variation sections may end their last pass on a turnaround (5th or 7th degree) instead.
  const turnaround = rng.chance(0.6) ? rng.pick([4, 6]) : null;
  let startBar = 0;
  return form.map((section, index): PlannedSection => {
    const progression = section.kind === "b" ? bridge : main;
    const pass = progression.length * per;
    const bars = Math.max(1, Math.round(section.bars));
    const degrees = Array.from({ length: bars }, (_, bar) => {
      const slot = Math.floor((bar % pass) / per) % progression.length;
      const finalPass = bar >= bars - pass;
      const swap = section.variation && turnaround !== null && finalPass && slot === progression.length - 1;
      return swap ? turnaround : progression[slot];
    });
    const planned = {
      ...section,
      bars,
      startBar,
      degrees,
      splits: degrees.map(() => null),
      next: form[(index + 1) % form.length],
    };
    startBar += bars;
    return planned;
  });
}

/** Spacious profiles stay on long holds. A pulse profile can move, but still prefers its own pace. */
function harmonicPool(profile: MusicProfile): HarmonicId[] {
  if (profile.chords.rhythm === "pulse") {
    return ["pulsed", "pulsed", "balanced", "mixed"];
  }
  if (profile.density.drums < 0.18 && profile.chords.barsPerChord >= 2) {
    return ["long", "long", "long", "mixed"];
  }
  return ["long", "long", "mixed"];
}

function collapseDegrees(degrees: readonly number[]) {
  const changes: number[] = [];
  for (const degree of degrees) {
    if (changes.length === 0 || changes[changes.length - 1] !== degree) {
      changes.push(degree);
    }
  }
  return changes;
}

/** A section often states its progression twice. Keep one loop, so holds can stretch it. */
function progressionCycle(changes: number[]) {
  for (let size = 1; size <= Math.floor(changes.length / 2); size += 1) {
    if (changes.length % size !== 0) {
      continue;
    }
    let repeats = true;
    for (let i = 0; i < changes.length; i += 1) {
      if (changes[i] !== changes[i % size]) {
        repeats = false;
        break;
      }
    }
    if (repeats) {
      return changes.slice(0, size);
    }
  }
  return changes;
}

/** Spread `bars` across `count` chords. Never lands on a 3-bar hold. */
function spreadHolds(count: number, bars: number, maxHold: 2 | 4) {
  const n = Math.min(Math.max(count, 1), bars);
  const sizes = Array.from({ length: n }, () => 1);
  let left = bars - n;
  for (let i = 0; i < n && left > 0; i += 1) {
    let give = Math.min(maxHold - sizes[i], left);
    if (sizes[i] + give === 3) {
      give = left > give && sizes[i] + give + 1 <= maxHold ? give + 1 : Math.max(0, give - 1);
    }
    if (give > 0) {
      sizes[i] += give;
      left -= give;
    }
  }
  while (left > 0) {
    const extra = left === 3 ? 2 : Math.min(left, maxHold);
    sizes.push(extra);
    left -= extra;
    if (left === 1 && extra === 2) {
      sizes.push(1);
      left = 0;
    }
  }
  return sizes;
}

/** Fewer chords, grown from the front, so an intro can sit on one harmony for four bars. */
function longHolds(count: number, bars: number) {
  const slots = Math.min(count, Math.max(1, Math.ceil(bars / 3)));
  return spreadHolds(slots, bars, 4);
}

/** Two chords across the section when it is long enough: four bars, then four bars. */
function spaciousHolds(count: number, bars: number) {
  const slots = Math.min(count, Math.max(1, Math.ceil(bars / 4)));
  return spreadHolds(slots, bars, 4);
}

function twoBarHolds(count: number, bars: number) {
  return spreadHolds(Math.min(count, bars), bars, 2);
}

function oneBarHolds(bars: number) {
  return Array.from({ length: bars }, () => 1);
}

/** Turn the last hold into two shorter ones so a section can cadence a little sooner. */
function withTailMotion(sizes: number[]) {
  if (sizes.length < 2 || sizes[sizes.length - 1] < 2) {
    return sizes;
  }
  const next = [...sizes];
  next[next.length - 1] -= 1;
  next.splice(next.length - 1, 0, 1);
  return next;
}

type SectionRole = "intro" | "a" | "a-var" | "return" | "b" | "breakdown";

function sectionRole(section: MusicSection, index: number, form: readonly PlannedSection[]): SectionRole {
  if (section.kind === "intro") {
    return "intro";
  }
  if (section.kind === "breakdown") {
    return "breakdown";
  }
  if (section.kind === "b") {
    return "b";
  }
  if (section.variation) {
    return "a-var";
  }
  if (index > 0 && form[index - 1]?.kind === "breakdown") {
    return "return";
  }
  return "a";
}

function durationSlots(id: HarmonicId, role: SectionRole, longest: boolean, count: number, bars: number) {
  const slow = role === "intro" || role === "breakdown";
  if (id === "pulsed" || id === "balanced") {
    return slow ? twoBarHolds(Math.max(1, Math.floor(bars / 2)), bars) : oneBarHolds(bars);
  }
  if (id === "mixed") {
    if (slow) {
      return longest ? spaciousHolds(count, bars) : longHolds(count, bars);
    }
    if (role === "b") {
      return longest ? withTailMotion(twoBarHolds(count, bars)) : oneBarHolds(bars);
    }
    if (role === "a-var" && !longest) {
      return withTailMotion(twoBarHolds(count, bars));
    }
    return twoBarHolds(count, bars);
  }
  if (slow || (longest && role === "b")) {
    return spaciousHolds(count, bars);
  }
  if (role === "a-var" && !longest) {
    return withTailMotion(twoBarHolds(count, bars));
  }
  return twoBarHolds(count, bars);
}

/**
 * Retimes the chords already chosen for each section. The order stays; only the
 * bar lengths change. Uses `harm` so the main random stream is left alone.
 */
function applyHarmonicRhythm(sections: PlannedSection[], profile: MusicProfile, harm: Rng): HarmonicId {
  const id = harm.pick(harmonicPool(profile));
  const longest = profile.chords.rhythm !== "pulse" && profile.density.drums < 0.18;
  const holdAt = id === "balanced" ? harm.int(1, 4) : -1;
  let splitsLeft = id === "balanced" && harm.chance(0.55) ? 1 : 0;
  let holdLeft = holdAt >= 0 ? 1 : 0;

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const role = sectionRole(section, index, sections);
    const changes = collapseDegrees(section.degrees);
    const cycle = progressionCycle(changes);
    const sizes = durationSlots(id, role, longest, Math.max(cycle.length, 1), section.bars);
    const degrees: number[] = [];
    const source = cycle.length > 0 ? cycle : section.degrees;
    sizes.forEach((size, chord) => {
      const degree = source[chord % source.length];
      for (let i = 0; i < size; i += 1) {
        degrees.push(degree);
      }
    });
    if (section.variation && degrees.length > 0 && degrees[degrees.length - 1] !== section.degrees[section.bars - 1]) {
      degrees[degrees.length - 1] = section.degrees[section.bars - 1];
    }
    if (holdLeft > 0 && role === "a" && degrees.length > 2) {
      const at = holdAt % (degrees.length - 1);
      if (degrees[at] !== degrees[at + 1]) {
        degrees[at + 1] = degrees[at];
        holdLeft = 0;
      }
    }
    const cadence =
      (id === "long" && !longest && (role === "a-var" || role === "b")) ||
      (id === "mixed" && !longest && role === "a-var") ||
      (id === "mixed" && longest && role === "b");
    if (cadence && degrees.length >= 4 && degrees[degrees.length - 1] === degrees[degrees.length - 2]) {
      const at = source.indexOf(degrees[degrees.length - 1]);
      const following = source[at < 0 ? 0 : (at + 1) % source.length];
      if (following !== undefined && following !== degrees[degrees.length - 1]) {
        degrees[degrees.length - 1] = following;
      }
    }
    const splits = degrees.map(() => null as number | null);
    if (splitsLeft > 0 && role === "b" && degrees.length > 1 && changes.length > 0) {
      const bar = degrees.length - 1;
      const following = changes[(changes.indexOf(degrees[bar]) + 1) % changes.length];
      if (following !== undefined && following !== degrees[bar]) {
        splits[bar] = following;
        splitsLeft = 0;
      }
    }
    while (degrees.length < section.bars) {
      degrees.push(degrees[degrees.length - 1] ?? source[0] ?? 0);
      splits.push(null);
    }
    section.degrees = degrees.slice(0, section.bars);
    section.splits = splits.slice(0, section.bars);
  }
  return id;
}

/** Pulse feels nocturnal. Dorian and aeolian stay modal. Major sustain stays floating. */
function harmonicCharacter(profile: MusicProfile): HarmonicCharacter {
  if (profile.chords.rhythm === "pulse") {
    return "nocturnal";
  }
  if (profile.scale === "dorian" || profile.scale === "aeolian") {
    return "modal";
  }
  return "floating";
}

const COLOR_POOLS: Record<HarmonicCharacter, { primary: ChordColorId[]; secondary: ChordColorId[]; accent: ChordColorId[] }> = {
  floating: {
    primary: ["plain", "plain", "plain", "add9", "sus2"],
    secondary: ["sus2", "add9", "six9", "six"],
    accent: ["sus2", "six", "add9"],
  },
  nocturnal: {
    primary: ["plain", "plain", "plain", "add9", "six"],
    secondary: ["add9", "six", "sus4", "plain"],
    accent: ["six", "sus4", "add9"],
  },
  modal: {
    primary: ["sus2", "sus2", "add9", "plain", "open"],
    secondary: ["sus4", "add9", "open", "six"],
    accent: ["sus4", "six", "open"],
  },
};

function pickDifferent(rng: Rng, pool: readonly ChordColorId[], avoid: readonly ChordColorId[]) {
  const options = pool.filter((color) => !avoid.includes(color));
  return rng.pick(options.length > 0 ? options : pool);
}

function pickPalette(profile: MusicProfile, rng: Rng, bassId: BassId): ColorPlan {
  const character = harmonicCharacter(profile);
  const pool = COLOR_POOLS[character];
  const primary = rng.pick(pool.primary);
  const secondary = pickDifferent(rng, pool.secondary, [primary]);
  const accent = pickDifferent(rng, pool.accent, [primary, secondary]);
  const chance = character === "nocturnal" ? 0.16 : character === "floating" ? 0.1 : 0.08;
  let substitution: ColorPlan["substitution"] = "none";
  if (rng.chance(chance)) {
    const rootBass = bassId === "anchor" || bassId === "held" || bassId === "octave";
    substitution = character === "nocturnal" && rootBass && rng.chance(0.45) ? "relative" : "sus";
  }
  return { character, primary, secondary, accent, substitution };
}

function simplerColor(color: ChordColorId): ChordColorId {
  if (color === "six" || color === "six9" || color === "relative") {
    return "add9";
  }
  return color;
}

const mod12 = (value: number) => ((value % 12) + 12) % 12;

function degreeInterval(scale: readonly number[], degree: number, step: number) {
  return mod12(degreeToSemitones(scale, degree + step) - degreeToSemitones(scale, degree));
}

function ninthClashes(scale: readonly number[], degree: number) {
  return degreeInterval(scale, degree, 1) === 1;
}

function thirdIsMinor(scale: readonly number[], degree: number) {
  return degreeInterval(scale, degree, 2) === 3;
}

/** Major third plus a minor seventh: a dominant, which floating pieces soften. */
function isDominant(scale: readonly number[], degree: number) {
  return degreeInterval(scale, degree, 2) === 4 && degreeInterval(scale, degree, 6) === 10;
}

function degreePcs(scale: readonly number[], degree: number, steps: readonly number[], keyPc: number) {
  const pcs: number[] = [];
  for (const step of steps) {
    const pc = mod12(keyPc + degreeToSemitones(scale, degree + step));
    if (!pcs.includes(pc)) {
      pcs.push(pc);
    }
  }
  return pcs;
}

function nativePcs(scale: readonly number[], degree: number, style: MusicProfile["chords"]["style"], keyPc: number) {
  return chordSemitones(scale, degree, style).map((semitone) => mod12(keyPc + semitone));
}

/** Scale-tone spelling of a color. `relative` moves to the chord that keeps this root as its third. */
/** A half step above the root is a flat 2, which does not sit as a gentle sus or add9. */
function hasFlatSecond(rootPc: number, pcs: readonly number[]) {
  return pcs.some((tone) => tone !== rootPc && mod12(tone - rootPc) === 1);
}

function spellColor(
  scale: readonly number[],
  degree: number,
  style: MusicProfile["chords"]["style"],
  color: ChordColorId,
  keyPc: number,
) {
  const spelled = (next: ChordColorId, root: number, pcs: number[]) => ({ color: next, degree: root, pcs });
  if (color === "plain") {
    return spelled("plain", degree, nativePcs(scale, degree, style, keyPc));
  }
  if (color === "relative") {
    const other = thirdIsMinor(scale, degree) ? degree - 2 : degree + 5;
    const pcs = nativePcs(scale, other, "seventh", keyPc);
    const rootPc = mod12(keyPc + degreeToSemitones(scale, degree));
    if (!pcs.includes(rootPc)) {
      return spelled("sus4", degree, degreePcs(scale, degree, [0, 3, 4], keyPc));
    }
    return spelled("relative", other, pcs);
  }
  if (color === "sus2") {
    return spelled("sus2", degree, degreePcs(scale, degree, [0, 1, 4], keyPc));
  }
  if (color === "sus4") {
    return spelled("sus4", degree, degreePcs(scale, degree, [0, 3, 4], keyPc));
  }
  if (color === "open") {
    const steps = ninthClashes(scale, degree) ? [0, 4] : [0, 4, 1];
    return spelled("open", degree, degreePcs(scale, degree, steps, keyPc));
  }
  if (color === "six") {
    return spelled("six", degree, degreePcs(scale, degree, [0, 2, 4, 5], keyPc));
  }
  if (color === "six9") {
    if (ninthClashes(scale, degree)) {
      return spelled("six", degree, degreePcs(scale, degree, [0, 2, 4, 5], keyPc));
    }
    return spelled("six9", degree, degreePcs(scale, degree, [0, 2, 5, 1], keyPc));
  }
  if (ninthClashes(scale, degree)) {
    return spelled("plain", degree, nativePcs(scale, degree, "seventh", keyPc));
  }
  return spelled("add9", degree, degreePcs(scale, degree, [0, 2, 4, 1], keyPc));
}

function guardColor(
  scale: readonly number[],
  degree: number,
  style: MusicProfile["chords"]["style"],
  color: ChordColorId,
  keyPc: number,
) {
  const spelled = spellColor(scale, degree, style, color, keyPc);
  const rootPc = mod12(keyPc + degreeToSemitones(scale, spelled.degree));
  if (!hasFlatSecond(rootPc, spelled.pcs)) {
    return spelled;
  }
  const plain = spellColor(scale, degree, style, "plain", keyPc);
  const plainRoot = mod12(keyPc + degreeToSemitones(scale, plain.degree));
  if (!hasFlatSecond(plainRoot, plain.pcs)) {
    return plain;
  }
  return { color: "open" as ChordColorId, degree, pcs: degreePcs(scale, degree, [0, 4], keyPc) };
}

/** A minor 6th sits a half step above the fifth, so it fights a fifth-bass figure. */
function fitsBass(color: ChordColorId, bassId: BassId, scale: readonly number[], degree: number) {
  const playsFifth = bassId === "fifth" || bassId === "sync";
  if (playsFifth && (color === "six" || color === "six9") && degreeInterval(scale, degree, 5) === 8) {
    return "add9" as ChordColorId;
  }
  return color;
}

function softenColor(plan: ColorPlan, scale: readonly number[], degree: number, color: ChordColorId) {
  if (plan.character === "floating" && isDominant(scale, degree) && (color === "plain" || color === "six" || color === "six9")) {
    return "sus2" as ChordColorId;
  }
  if (plan.character === "modal" && isDominant(scale, degree)) {
    return color === "plain" ? "sus4" : color;
  }
  return color;
}

function pulseThisSection(profile: MusicProfile, id: HarmonicId, role: SectionRole) {
  if (profile.chords.rhythm !== "pulse") {
    return false;
  }
  if (role === "intro" || role === "breakdown") {
    return false;
  }
  return id === "pulsed" || id === "balanced" || id === "mixed";
}

function renderHarmony(
  profile: MusicProfile,
  scale: readonly number[],
  keyPc: number,
  sections: PlannedSection[],
  harm: Rng,
  feel: Feel,
  openVoicing: boolean,
  id: HarmonicId,
  colorRng: Rng,
  bassId: BassId,
) {
  const plan = pickPalette(profile, colorRng, bassId);
  const events: ChordEvent[] = [];
  const colors: ChordColorId[] = [];
  const pulseStep = harm.pick([10, 11, 14]);
  const strum = 0.005 + harm.next() * 0.008;
  const softness = clamp01(profile.space.softness);
  let previous: number[] | null = null;
  let previousNative: number[] | null = null;
  let dropFifth = false;
  let nativeRich = false;
  let currentColor: ChordColorId = plan.primary;
  let accentSection = -1;
  let subLeft = plan.substitution !== "none";

  const paint = (role: SectionRole, degree: number, sectionIndex: number, bar: number, colorDegree: number | null) => {
    let color: ChordColorId;
    if (role === "intro" || role === "breakdown") {
      color = simplerColor(plan.primary);
    } else if (role === "return") {
      color = plan.primary;
    } else if (subLeft && role === "b" && bar === 0) {
      subLeft = false;
      color = plan.substitution === "relative" ? "relative" : plan.primary === "sus4" ? "sus2" : "sus4";
    } else if (colorDegree !== null && degree === colorDegree && role === "a-var" && (accentSection < 0 || accentSection === sectionIndex)) {
      accentSection = sectionIndex;
      color = plan.accent;
    } else if (colorDegree !== null && degree === colorDegree && (role === "a" || role === "b" || role === "a-var")) {
      color = plan.secondary;
    } else {
      color = plan.primary;
    }
    return softenColor(plan, scale, degree, fitsBass(color, bassId, scale, degree));
  };

  const spare = (color: ChordColorId) => color === "sus2" || color === "sus4" || color === "open";

  const emit = (
    step: number,
    length: number,
    velocity: number,
    voicing: number[],
    {
      spread,
      rootPc,
      omitRoot,
      reshape,
      dropFifth: drop,
    }: { spread: number; rootPc: number; omitRoot: boolean; reshape: boolean; dropFifth: boolean },
  ) => {
    const color = currentColor;
    let notes = omitRoot && !spare(color) && color !== "relative" ? voicing.filter((note) => note % 12 !== rootPc) : [...voicing];
    if (drop && !spare(color) && color !== "six9") {
      const fifth = (rootPc + 7) % 12;
      const kept = notes.filter((note) => note % 12 !== fifth);
      if (kept.length >= 3) {
        notes = kept;
      }
    }
    if (reshape) {
      const top = notes[notes.length - 1];
      const rootAbove = top + 1 + ((((rootPc - top - 1) % 12) + 12) % 12);
      const gap = rootAbove - top;
      if (rootAbove <= 79 && gap <= 7 && gap > 1) {
        notes = [...notes, rootAbove];
      } else if (gap !== 1 && notes.length > 3) {
        notes = notes.slice(1);
      }
    }
    colors.push(color);
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

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const role = sectionRole(section, index, sections);
    const distinct = collapseDegrees(section.degrees);
    const colorDegree = distinct.length > 1 ? distinct[1] : null;
    const soft = section.kind === "intro" ? 0.85 : 1;
    const pulse = pulseThisSection(profile, id, role);
    const arpeggioSection = section.kind === "intro" || section.kind === "breakdown";
    let bar = 0;
    while (bar < section.bars) {
      const degree = section.degrees[bar];
      const split = section.splits[bar];
      let run = 1;
      if (split === null) {
        while (
          bar + run < section.bars &&
          section.degrees[bar + run] === degree &&
          section.splits[bar + run] === null
        ) {
          run += 1;
        }
      }
      const startChange = bar === 0 || section.degrees[bar] !== section.degrees[bar - 1] || split !== null;
      let voicing: number[] = previous ?? [];
      let rootPc = mod12(keyPc + degreeToSemitones(scale, degree));
      if (startChange || !previous) {
        const native = chordSemitones(scale, degree, profile.chords.style).map((semitone) => mod12(keyPc + semitone));
        const nativeNearest: number[] = voiceChord(native, previousNative, undefined, openVoicing && previousNative === null);
        const nativeAlt: number[] = section.variation && bar === 0 ? voiceChord(native, previousNative, nativeNearest) : [];
        const nativeVoicing: number[] = nativeAlt.length > 0 ? nativeAlt : nativeNearest;
        previousNative = nativeVoicing;
        nativeRich = nativeVoicing.length >= 4;
        dropFifth = openVoicing && nativeRich && section.bass > 0 && harm.chance(0.12);
        const spelled = guardColor(scale, degree, profile.chords.style, paint(role, degree, index, bar, colorDegree), keyPc);
        currentColor = spelled.color;
        const nearest = voiceChord(spelled.pcs, previous, undefined, openVoicing && previous === null);
        const alternate = section.variation && bar === 0 ? voiceChord(spelled.pcs, previous, nearest) : [];
        const rubs = (notes: number[]) => notes.some((note, noteIndex) => noteIndex > 0 && note - notes[noteIndex - 1] === 1);
        voicing = alternate.length > 0 && !rubs(alternate) ? alternate : nearest;
        rootPc = mod12(keyPc + degreeToSemitones(scale, spelled.degree));
      }
      previous = voicing;
      const start = (section.startBar + bar) * STEPS_PER_BAR;
      const omit = (chance: number) => nativeRich && section.bass > 0 && harm.chance(chance);
      const lastBar = bar + run >= section.bars;
      const reshape = lastBar && harm.chance(0.4);

      if (split !== null) {
        emit(start, 7, 0.8 * soft, voicing, { spread: strum, rootPc, omitRoot: false, reshape: false, dropFifth });
        const nativeNext = chordSemitones(scale, split, profile.chords.style).map((semitone) => mod12(keyPc + semitone));
        previousNative = voiceChord(nativeNext, previousNative);
        nativeRich = previousNative.length >= 4;
        const spelled = guardColor(scale, split, profile.chords.style, paint(role, split, index, bar, colorDegree), keyPc);
        currentColor = spelled.color;
        const nextVoicing = voiceChord(spelled.pcs, voicing);
        if (nextVoicing.some((note, noteIndex) => noteIndex > 0 && note - nextVoicing[noteIndex - 1] === 1)) {
          const cleaner = voiceChord(spelled.pcs, voicing, nextVoicing);
          if (cleaner.length > 0 && !cleaner.some((note, noteIndex) => noteIndex > 0 && note - cleaner[noteIndex - 1] === 1)) {
            nextVoicing.splice(0, nextVoicing.length, ...cleaner);
          }
        }
        const nextRoot = mod12(keyPc + degreeToSemitones(scale, spelled.degree));
        emit(start + 8, 7, 0.72 * soft, nextVoicing, {
          spread: strum,
          rootPc: nextRoot,
          omitRoot: false,
          reshape,
          dropFifth: false,
        });
        previous = nextVoicing;
        bar += 1;
        continue;
      }

      if (pulse) {
        for (let i = 0; i < run; i += 1) {
          const at = start + i * STEPS_PER_BAR;
          emit(at, 6, 0.85 * soft, voicing, { spread: strum, rootPc, omitRoot: false, reshape: false, dropFifth });
          if (!harm.chance(0.1)) {
            emit(at + pulseStep, 3, 0.55 * soft, voicing, {
              spread: strum * 0.5,
              rootPc,
              omitRoot: omit(0.3),
              reshape: i === run - 1 && reshape,
              dropFifth,
            });
          }
        }
      } else {
        const arpeggio = arpeggioSection && harm.chance(0.4 + softness * 0.4);
        emit(start, run * STEPS_PER_BAR - 1, 0.8 * soft, voicing, {
          spread: arpeggio ? 0.045 + harm.next() * 0.045 : strum,
          rootPc,
          omitRoot: omit(0.15),
          reshape,
          dropFifth,
        });
      }
      bar += run;
    }
  }
  return { events, colors, plan };
}

function buildChords(
  profile: MusicProfile,
  scale: readonly number[],
  keyPc: number,
  sections: PlannedSection[],
  rng: Rng,
  feel: Feel,
  openVoicing: boolean,
) {
  const events: ChordEvent[] = [];
  const pulse = profile.chords.rhythm === "pulse";
  const pulseStep = rng.pick([10, 11, 14]);
  const strum = 0.005 + rng.next() * 0.008;
  const softness = clamp01(profile.space.softness);
  let previous: number[] | null = null;
  let dropFifth = false;

  const emit = (
    step: number,
    length: number,
    velocity: number,
    voicing: number[],
    {
      spread,
      rootPc,
      omitRoot,
      reshape,
      dropFifth,
    }: { spread: number; rootPc: number; omitRoot: boolean; reshape: boolean; dropFifth: boolean },
  ) => {
    let notes = omitRoot ? voicing.filter((note) => note % 12 !== rootPc) : [...voicing];
    if (dropFifth) {
      const fifth = (rootPc + 7) % 12;
      const kept = notes.filter((note) => note % 12 !== fifth);
      if (kept.length >= 3) {
        notes = kept;
      }
    }
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
        // The first chord may sit a little more open; later chords follow it by voice leading.
        const nearest = voiceChord(pcs, previous, undefined, openVoicing && previous === null);
        // Variations open on the next-closest inversion, so a repeat sounds re-voiced.
        const alternate = section.variation && bar === 0 ? voiceChord(pcs, previous, nearest) : [];
        voicing = alternate.length > 0 ? alternate : nearest;
        dropFifth = openVoicing && voicing.length >= 4 && section.bass > 0 && rng.chance(0.12);
      }
      previous = voicing;

      const start = (section.startBar + bar) * STEPS_PER_BAR;
      const rootPc = (keyPc + degreeToSemitones(scale, degree)) % 12;
      // Rootless restrikes are fine when the bass is holding the root.
      const omit = (chance: number) => voicing.length >= 4 && section.bass > 0 && rng.chance(chance);
      const lastBar = bar === section.bars - 1;
      const reshape = lastBar && rng.chance(0.4);

      if (pulse) {
        emit(start, 6, 0.85 * soft, voicing, { spread: strum, rootPc, omitRoot: false, reshape: false, dropFifth });
        if (!rng.chance(0.1)) {
          emit(start + pulseStep, 3, 0.55 * soft, voicing, {
            spread: strum * 0.5,
            rootPc,
            omitRoot: omit(0.3),
            reshape,
            dropFifth,
          });
        }
      } else if (changes) {
        let bars = 1;
        // Hold the chord for the whole run of this degree. Capping at `barsPerChord`
        // drops the attack when a variation turnaround repeats the previous harmony,
        // leaving those bars with no chord at all.
        while (bar + bars < section.bars && section.degrees[bar + bars] === degree) {
          bars += 1;
        }
        const arpeggio = arpeggioSection && rng.chance(0.4 + softness * 0.4);
        emit(start, bars * STEPS_PER_BAR - 1, 0.8 * soft, voicing, {
          spread: arpeggio ? 0.045 + rng.next() * 0.045 : strum,
          rootPc,
          omitRoot: omit(0.15),
          reshape: bar + bars >= section.bars && reshape,
          dropFifth,
        });
      }
    }
  }
  return events;
}

type BassTone = "root" | "fifth" | "third" | "octave" | "approach";
type BassSlot = { step: number; length: number; tone: BassTone };

const BASS_ARCHETYPES: Record<BassId, readonly BassSlot[]> = {
  anchor: [{ step: 0, length: 12, tone: "root" }],
  held: [{ step: 0, length: 14, tone: "root" }],
  fifth: [
    { step: 0, length: 8, tone: "root" },
    { step: 8, length: 6, tone: "fifth" },
  ],
  sync: [
    { step: 0, length: 4, tone: "root" },
    { step: 10, length: 4, tone: "fifth" },
  ],
  approach: [
    { step: 0, length: 10, tone: "root" },
    { step: 14, length: 2, tone: "approach" },
  ],
  octave: [
    { step: 0, length: 8, tone: "root" },
    { step: 8, length: 5, tone: "octave" },
  ],
};

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
  bassId: BassId,
) {
  const degreeAt = sections.flatMap((section) => section.degrees);
  const events: NoteEvent[] = [];

  for (const section of sections) {
    if (section.bass <= 0) {
      continue;
    }
    const level = clamp01(profile.density.bass) * clamp01(section.bass);
    const pattern = BASS_ARCHETYPES[bassId];
    const alteredBar = section.variation ? rng.int(1, Math.max(1, section.bars - 1)) : -1;
    let skip = 0;

    for (let bar = 0; bar < section.bars; bar += 1) {
      if (skip > 0) {
        skip -= 1;
        continue;
      }
      const absBar = section.startBar + bar;
      const degree = degreeAt[absBar];
      const nextDegree = degreeAt[(absBar + 1) % degreeAt.length];
      const root = bassRoot(keyPc, scale, degree);
      const triad = chordSemitones(scale, degree, "triad");
      const changes = nextDegree !== degree;
      const split = section.splits[bar];
      const lastBar = bar === section.bars - 1;
      const tailRest = lastBar && section.next.bass <= 0;
      let slots = pattern.map((slot) => ({ ...slot }));
      // Quiet sections keep the root of the archetype instead of the whole figure.
      if (level < 0.22 && slots.length > 1) {
        const rootSlot = slots.find((slot) => slot.tone === "root") ?? { step: 0, length: 12, tone: "root" as const };
        slots = [{ ...rootSlot }];
      }
      let spanBars = 1;
      if (bassId === "held" && !changes && !tailRest) {
        while (spanBars < 4 && bar + spanBars < section.bars && degreeAt[absBar + spanBars] === degree) {
          spanBars += 1;
        }
      }
      if (spanBars > 1) {
        slots = [{ step: 0, length: spanBars * STEPS_PER_BAR - 2, tone: "root" }];
      }
      // One altered note per variation section keeps repeats from being literal copies.
      if (bar === alteredBar && spanBars === 1 && !tailRest) {
        const fifth = slots.findIndex((slot) => slot.tone === "fifth");
        if (fifth >= 0) {
          slots[fifth] = { ...slots[fifth], tone: "octave" };
        } else if (slots.length === 1) {
          slots[0] = { ...slots[0], length: Math.min(slots[0].length, 8) };
          slots.push({ step: 10, length: 4, tone: "fifth" });
        }
      }

      slots.forEach((slot) => {
        if ((slot.tone === "approach" && !changes) || (tailRest && slot.step >= 8)) {
          return;
        }
        const localDegree = split !== null && slot.step >= 8 && slot.tone !== "approach" ? split : degree;
        const localRoot = localDegree === degree ? root : bassRoot(keyPc, scale, localDegree);
        const localTriad = localDegree === degree ? triad : chordSemitones(scale, localDegree, "triad");
        let midi = localRoot;
        if (slot.tone === "octave") {
          midi = localRoot + 12;
        } else if (slot.tone === "fifth") {
          midi = localRoot + (localTriad[2] - localTriad[0]);
        } else if (slot.tone === "third") {
          midi = localRoot + (localTriad[1] - localTriad[0]);
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
      skip = spanBars - 1;
    }
  }
  return events;
}

type GrooveShape = {
  kicks: number[];
  extraKicks: number[];
  snares: number[];
  hatEvery: number;
  ghostSnare: number | null;
  openHat: number | null;
  pickup: number | null;
  fill: boolean;
  snareVelocity: number;
};

const GROOVES: Record<GrooveId, GrooveShape> = {
  sparse: {
    kicks: [0],
    extraKicks: [8],
    snares: [8],
    hatEvery: 4,
    ghostSnare: null,
    openHat: null,
    pickup: null,
    fill: true,
    snareVelocity: 0.72,
  },
  halftime: {
    kicks: [0],
    extraKicks: [],
    snares: [8],
    hatEvery: 8,
    ghostSnare: null,
    openHat: null,
    pickup: null,
    fill: false,
    snareVelocity: 0.62,
  },
  "kick-light": {
    kicks: [],
    extraKicks: [],
    snares: [8],
    hatEvery: 4,
    ghostSnare: null,
    openHat: null,
    pickup: null,
    fill: false,
    snareVelocity: 0.6,
  },
  backbeat: {
    kicks: [0],
    extraKicks: [8],
    snares: [4, 12],
    hatEvery: 2,
    ghostSnare: 15,
    openHat: 14,
    pickup: 13,
    fill: true,
    snareVelocity: 0.8,
  },
  syncopated: {
    kicks: [0],
    extraKicks: [10],
    snares: [4, 12],
    hatEvery: 2,
    ghostSnare: 7,
    openHat: 6,
    pickup: null,
    fill: false,
    snareVelocity: 0.76,
  },
};

function buildDrums(profile: MusicProfile, sections: PlannedSection[], rng: Rng, feel: Feel, groove: GrooveId) {
  const density = clamp01(profile.density.drums);
  const shape = GROOVES[groove];
  // A couple of holes, chosen once, so a syncopated hat part is not a straight grid.
  const hatDrop = new Set<number>();
  if (groove === "syncopated") {
    hatDrop.add(rng.pick([2, 6]));
    hatDrop.add(rng.pick([10, 14]));
  }
  const hits: DrumHit[] = [];

  for (const section of sections) {
    const level = clamp01(section.drums);
    if (level <= 0) {
      continue;
    }
    const core = level >= 0.5;
    const full = level >= 0.75;
    const extras = level >= 0.95 && density >= 0.4;
    const hatLevel = 0.6 + 0.4 * level;

    for (let bar = 0; bar < section.bars; bar += 1) {
      const base = (section.startBar + bar) * STEPS_PER_BAR;
      const used = new Set<string>();
      const add = (step: number, kind: DrumHit["kind"], velocity: number, tight: boolean) => {
        const key = `${step}:${kind}`;
        if (used.has(key)) {
          return;
        }
        used.add(key);
        hits.push({
          step: base + step,
          kind,
          velocity: humanize(feel, velocity, tight ? 0.3 : 1),
          nudge: lateness(feel, step, tight ? 0.3 : 1),
        });
      };
      const fill = core && shape.fill && bar === section.bars - 1 && rng.chance(0.45);

      if (core) {
        const kicks =
          groove === "kick-light" ? (bar % 2 === 0 ? [0] : []) : [...shape.kicks, ...(full ? shape.extraKicks : [])];
        for (const step of kicks) {
          if (!(fill && step > 8)) {
            add(step, "kick", step === 0 ? 1 : 0.72, true);
          }
        }
        for (const step of shape.snares) {
          add(step, "snare", shape.snareVelocity, true);
        }
        if (full && shape.ghostSnare !== null && density > 0.4) {
          add(shape.ghostSnare, "snare", 0.22, false);
        }
        if (fill) {
          add(14, "snare", 0.4, false);
          if (density > 0.5) {
            add(15, "snare", 0.25, false);
          }
        }
      }

      const openAt = extras && bar % 2 === 1 ? shape.openHat : null;
      const pickupAt = extras && bar % 2 === 1 ? shape.pickup : null;
      for (let step = 0; step < STEPS_PER_BAR; step += 1) {
        if (step === openAt) {
          add(step, "openHat", 0.5 * hatLevel, false);
          continue;
        }
        if (step % shape.hatEvery === 0 && !hatDrop.has(step)) {
          add(step, "hat", (step % 4 === 0 ? 0.55 : 0.35) * hatLevel, false);
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

type MotifMove = "same" | "ending" | "truncate" | "extend" | "omit" | "shift" | "up";

/** A small change that leaves the rhythm and contour recognizable. */
function developMotif(motif: Motif, move: MotifMove, endingDir: number): Motif {
  const last = motif.contour.length - 1;
  if (move === "ending" && last > 0) {
    return { ...motif, contour: motif.contour.map((c, i) => (i === last ? c + endingDir : c)) };
  }
  if (move === "truncate") {
    return {
      ...motif,
      lengths: motif.lengths.map((length, i) => (i === last ? Math.max(2, length - 2) : length)),
    };
  }
  if (move === "extend") {
    return {
      ...motif,
      lengths: motif.lengths.map((length, i) => (i === last ? Math.min(length + 2, 8) : length)),
    };
  }
  if (move === "omit") {
    if (motif.steps.length < 3) {
      return developMotif(motif, "truncate", endingDir);
    }
    return {
      ...motif,
      steps: motif.steps.slice(0, -1),
      lengths: motif.lengths.slice(0, -1),
      contour: motif.contour.slice(0, -1),
    };
  }
  if (move === "shift") {
    const steps = motif.steps.map((step) => step + 2);
    return steps[steps.length - 1] <= 12 ? { ...motif, steps } : motif;
  }
  if (move === "up") {
    return { ...motif, startTone: motif.startTone + 1 };
  }
  return motif;
}

function motifCycle(rng: Rng, rich: boolean): MotifMove[] {
  return [
    "same",
    "same",
    rng.pick(["ending", "extend"]),
    rich ? rng.pick(["up", "shift", "omit"]) : rng.pick(["truncate", "omit"]),
  ];
}

function buildMelody(
  profile: MusicProfile,
  scale: readonly number[],
  keyPc: number,
  sections: PlannedSection[],
  rng: Rng,
  feel: Feel,
  rich: boolean,
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

  // One motif for the piece. Repeats develop it; `b` answers from the next chord tone.
  const motif = makeMotif(peak, rng);
  const cycle = motifCycle(rng, rich);
  const endingDir = rng.chance(0.5) ? 1 : -1;
  const offsetSeed = rng.int(0, 2);

  const events: NoteEvent[] = [];
  let phrase = 0;
  for (const section of sections) {
    const level = peak * clamp01(section.melody);
    if (level <= 0) {
      continue;
    }
    // Sparse: one phrase per 8, 4 or 2 bars, never on a section's first bar.
    const every = level < 0.2 ? 8 : level < 0.4 ? 4 : 2;
    const offset = 1 + (offsetSeed % Math.min(every - 1, 3));
    for (let bar = offset; bar < section.bars; bar += every) {
      // The motif is stated twice before a repeat may be skipped.
      if (phrase >= 2 && rng.chance(0.1)) {
        continue;
      }
      const delay = rng.chance(0.15) ? rng.pick([1, 2]) : 0;
      const move = cycle[phrase % cycle.length];
      phrase += 1;
      const developed = developMotif(motif, move, endingDir);
      const shape = section.kind === "b" ? { ...developed, startTone: developed.startTone + 1 } : developed;

      const firstStep = shape.steps[0] + delay;
      const lastStep = shape.steps[shape.steps.length - 1] + delay;
      const splitDegree = section.splits[bar];
      const chordDegree = firstStep >= 8 && splitDegree !== null ? splitDegree : section.degrees[bar];
      const resolveDegree = lastStep >= 8 && splitDegree !== null ? splitDegree : chordDegree;
      const degrees = shape.contour.map((c) => snap(chordDegree + shape.startTone * 2 + c));
      // Resolve on the chord's root or third, whichever is nearest.
      const last = degrees.length - 1;
      const targets = [-7, -5, 0, 2, 7, 9].map((t) => resolveDegree + t);
      degrees[last] = targets.reduce((a, b) => (Math.abs(b - degrees[last]) < Math.abs(a - degrees[last]) ? b : a));

      // Centre the phrase near G4–A4 and keep it under G5, so high notes stay rare.
      const pitches = degrees.map(toMidi);
      const low = Math.min(...pitches);
      const high = Math.max(...pitches);
      const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
      const center = section.kind === "b" ? 74 : move === "up" ? 66 : 70;
      const shifts = [-24, -12, 0, 12, 24].filter((s) => high + s <= 79 && low + s >= 60);
      const shift = (shifts.length > 0 ? shifts : [-24]).reduce(
        (a, b) => (Math.abs(mean + b - center) < Math.abs(mean + a - center) ? b : a),
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
    }
  }
  return events;
}

type MelodicCharacter = "drifting" | "hook" | "modal";
type MelodyTransform = "same" | "transpose" | "invert" | "ending" | "omit" | "extend" | "shift" | "octave";

/** Pulse worlds can carry a short hook. Very quiet pentatonic worlds stay modal. */
function melodicCharacter(profile: MusicProfile): MelodicCharacter {
  if (profile.chords.rhythm === "pulse") {
    return "hook";
  }
  if (profile.density.melody < 0.1 && profile.melodyScale === "pentatonic") {
    return "modal";
  }
  return "drifting";
}

function motifPool(character: MelodicCharacter): MotifId[] {
  if (character === "hook") {
    return ["call", "call", "repeat", "repeat", "pickup", "pickup", "neighbor", "leap"];
  }
  if (character === "modal") {
    return ["leap", "leap", "held", "held", "descend", "descend", "neighbor"];
  }
  return ["descend", "descend", "descend", "held", "held", "repeat", "repeat", "neighbor"];
}

function registerPool(character: MelodicCharacter): MelodicRegister[] {
  if (character === "hook") {
    return ["mid", "mid", "high", "low"];
  }
  if (character === "modal") {
    return ["low", "low", "low", "mid"];
  }
  return ["low", "low", "mid"];
}

const REGISTER_CENTER: Record<MelodicCharacter, Record<MelodicRegister, number>> = {
  drifting: { low: 64, mid: 67, high: 70 },
  modal: { low: 62, mid: 65, high: 67 },
  hook: { low: 67, mid: 70, high: 73 },
};

const MOTIF_RHYTHM: Record<MotifId, MelodicRhythm> = {
  descend: "long-short",
  held: "sustain",
  repeat: "even-resolve",
  neighbor: "sparse",
  leap: "short-rest",
  call: "even-resolve",
  pickup: "sync",
};

const MOTIF_CONTOUR: Record<MotifId, MelodicContour> = {
  descend: "down",
  held: "down",
  repeat: "repeat",
  neighbor: "neighbor",
  leap: "leap",
  call: "up",
  pickup: "up",
};

function chooseRhythm(home: MelodicRhythm, character: MelodicCharacter, rng: Rng): MelodicRhythm {
  if (character !== "hook" && home === "sync") {
    return "long-short";
  }
  if (rng.chance(0.8)) {
    return home;
  }
  const options: MelodicRhythm[] =
    character === "hook" ? [home, "even-resolve", "sparse", "short-rest"] : [home, "long-short", "sustain", "sparse"];
  return rng.pick(options);
}

function chooseContour(home: MelodicContour, character: MelodicCharacter, rng: Rng): MelodicContour {
  if (rng.chance(0.58)) {
    return home;
  }
  if (home === "leap") {
    return rng.pick(["down", "neighbor"]);
  }
  if (character === "hook") {
    return rng.pick(["up", "repeat", "neighbor", "arch"]);
  }
  return rng.pick(["down", "arch", "valley", "neighbor"]);
}

/** A syncopated phrase keeps a simple line. A leap does not also syncopate. */
function simplifyPair(rhythm: MelodicRhythm, contour: MelodicContour) {
  if (rhythm === "sync" && (contour === "leap" || contour === "arch" || contour === "valley")) {
    return { rhythm, contour: "up" as MelodicContour };
  }
  if (contour === "leap" && rhythm === "sync") {
    return { rhythm: "short-rest" as MelodicRhythm, contour };
  }
  return { rhythm, contour };
}

function phraseEvery(character: MelodicCharacter, level: number, rng: Rng) {
  if (character === "hook") {
    if (level >= 0.22) {
      return rng.pick([4, 4, 6, 4]);
    }
    if (level >= 0.12) {
      return rng.pick([4, 6, 4]);
    }
    return 8;
  }
  if (level >= 0.08) {
    return rng.pick([8, 8, 8, 6]);
  }
  return 8;
}

function rhythmShape(rhythm: MelodicRhythm, count: number) {
  const shapes: Record<MelodicRhythm, { steps: number[]; lengths: number[] }> = {
    "long-short": { steps: [0, 8, 10], lengths: [6, 2, 2] },
    "short-rest": { steps: [0, 6, 8], lengths: [2, 2, 6] },
    "even-resolve": { steps: [0, 8, 12], lengths: [3, 3, 3] },
    sustain: { steps: [0, 10], lengths: [8, 3] },
    sparse: { steps: [2, 8, 12], lengths: [3, 2, 3] },
    sync: { steps: [3, 6, 10], lengths: [2, 3, 4] },
  };
  const shape = shapes[rhythm];
  const notes = Math.max(1, Math.min(count, shape.steps.length));
  return { steps: shape.steps.slice(0, notes), lengths: shape.lengths.slice(0, notes) };
}

function contourShape(contour: MelodicContour, count: number, leap: number) {
  const table: Record<MelodicContour, number[]> = {
    down: [0, -1, -2],
    up: [0, 1, 2],
    arch: [0, 1, 0],
    valley: [0, -1, 0],
    repeat: [0, 0, 1],
    leap: [0, leap, leap > 0 ? leap - 1 : leap + 1],
    neighbor: [0, 1, 0],
  };
  const notes = Math.max(1, Math.min(count, 3));
  return table[contour].slice(0, notes);
}

function invertContour(contour: readonly number[]) {
  const next = contour.map((value, index) => (index === 0 ? 0 : -value));
  if (next.length > 1 && next.every((value, index) => value === contour[index])) {
    next[next.length - 1] -= 1;
  }
  return next;
}

function answerRhythm(rhythm: MelodicRhythm): MelodicRhythm {
  if (rhythm === "sync") {
    return "even-resolve";
  }
  if (rhythm === "long-short") {
    return "sparse";
  }
  return rhythm;
}

function motifNotes(motif: MotifId) {
  return motif === "call" || motif === "held" ? 2 : 3;
}

function degreePitchClass(scale: readonly number[], degree: number, keyPc: number) {
  return (((keyPc + degreeToSemitones(scale, degree)) % 12) + 12) % 12;
}

/** Closest scale degree whose pitch is actually in the sounding chord. */
function nearestVoicedDegree(desired: number, scale: readonly number[], keyPc: number, chordPcs: ReadonlySet<number>) {
  let best = desired;
  let bestDist = 100;
  for (let delta = -10; delta <= 10; delta += 1) {
    const candidate = desired + delta;
    if (!chordPcs.has(degreePitchClass(scale, candidate, keyPc))) {
      continue;
    }
    if (Math.abs(delta) < bestDist) {
      best = candidate;
      bestDist = Math.abs(delta);
    }
  }
  return bestDist < 100 ? best : desired;
}

function pullInterval(degree: number, previous: number) {
  let next = degree;
  while (next - previous > 4) {
    next -= 7;
  }
  while (previous - next > 4) {
    next += 7;
  }
  return next;
}

function soundingPcs(chords: readonly ChordEvent[], bar: number, stepInBar: number) {
  let cover: ChordEvent | null = null;
  for (const event of chords) {
    const eventBar = Math.floor(event.step / 16);
    const eventStep = event.step % 16;
    if (eventStep === 8 && event.length >= 7 && eventBar === bar && stepInBar >= 8) {
      return [...new Set(event.notes.map((midi) => ((midi % 12) + 12) % 12))];
    }
    if (eventStep !== 0) {
      continue;
    }
    if (event.length >= 15) {
      const hold = (event.length + 1) / 16;
      if (bar >= eventBar && bar < eventBar + hold) {
        cover = event;
      }
    } else if (eventBar === bar) {
      cover = event;
    }
  }
  return cover ? [...new Set(cover.notes.map((midi) => ((midi % 12) + 12) % 12))] : [];
}

function renderMelody(
  profile: MusicProfile,
  scale: readonly number[],
  keyPc: number,
  sections: PlannedSection[],
  chords: readonly ChordEvent[],
  rng: Rng,
  feel: Feel,
) {
  const character = melodicCharacter(profile);
  const motif = rng.pick(motifPool(character));
  const leap = (character === "modal" ? 4 : 3) * (rng.chance(0.5) ? 1 : -1);
  const register = rng.pick(registerPool(character));
  const paired = simplifyPair(chooseRhythm(MOTIF_RHYTHM[motif], character, rng), chooseContour(MOTIF_CONTOUR[motif], character, rng));
  const rhythm = paired.rhythm;
  const contour = paired.contour;
  const startTone = rng.pick(character === "hook" ? [0, 2, 4] : [0, 2]);
  const simplifyReturn = rng.chance(0.55);
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
  const center = REGISTER_CENTER[character][register];
  const answerTone = startTone === 0 ? 2 : 0;
  let primaryStatements = 0;

  const events: NoteEvent[] = [];

  const emit = (
    section: PlannedSection,
    bar: number,
    family: "A" | "B" | "C" | "tone",
    transform: MelodyTransform,
  ) => {
    let useRhythm = family === "B" ? answerRhythm(rhythm) : rhythm;
    let useStart = family === "B" ? answerTone : startTone;
    let count = family === "tone" ? 1 : family === "C" ? (character === "hook" ? 2 : 1) : motifNotes(motif);
    if (family === "C") {
      useRhythm = count === 1 ? "sustain" : rhythm;
    }
    if (transform === "transpose") {
      useStart = useStart === 0 ? 2 : useStart === 2 ? 4 : 0;
    }
    if (transform === "omit" && count > 2) {
      count -= 1;
    }
    const shape = rhythmShape(useRhythm, count);
    if (family === "tone") {
      shape.steps = [0];
      shape.lengths = [12];
    }
    let line = contourShape(contour, shape.steps.length, leap);
    if (family === "B" || transform === "invert") {
      line = invertContour(line);
    }
    if (transform === "shift" && useRhythm !== "sync" && shape.steps[shape.steps.length - 1] + 2 <= 12) {
      shape.steps = shape.steps.map((step) => step + 2);
    }
    if (transform === "extend") {
      const last = shape.lengths.length - 1;
      shape.lengths[last] = Math.min(shape.lengths[last] + 4, 16 - shape.steps[last]);
    }
    const lastStep = shape.steps[shape.steps.length - 1];
    const delay =
      useRhythm === "sync" || lastStep + shape.lengths[shape.lengths.length - 1] + 2 > 16
        ? 0
        : rng.chance(0.2)
          ? 2
          : 0;
    const colorEnding = transform === "ending" || (character === "modal" && family !== "tone" && rng.chance(0.55));
    const degrees: number[] = [];
    for (let i = 0; i < shape.steps.length; i += 1) {
      const stepInBar = shape.steps[i] + delay;
      const chord = section.splits[bar] !== null && stepInBar >= 8 ? section.splits[bar]! : section.degrees[bar];
      const voiced = soundingPcs(chords, section.startBar + bar, stepInBar);
      const chordPcs = new Set(
        voiced.length > 0 ? voiced : chordSemitones(scale, chord, profile.chords.style).map((semitone) => (keyPc + semitone) % 12),
      );
      const desired = chord + useStart + (line[i] ?? 0);
      const strong =
        i === 0 || i === shape.steps.length - 1 || stepInBar % 4 === 0 || Math.abs((line[i] ?? 0) - (line[i - 1] ?? 0)) >= 3;
      let degree = strong ? nearestVoicedDegree(desired, scale, keyPc, chordPcs) : snap(desired);
      if (colorEnding && i === shape.steps.length - 1 && chordPcs.size > 1) {
        const rootPc = degreePitchClass(scale, chord, keyPc);
        const rest = new Set([...chordPcs].filter((pc) => pc !== rootPc));
        if (rest.size > 0) {
          degree = nearestVoicedDegree(desired, scale, keyPc, rest);
        }
      }
      if (i > 0) {
        degree = pullInterval(degree, degrees[i - 1]);
      }
      degrees.push(degree);
    }
    const pitches = degrees.map(toMidi);
    const low = Math.min(...pitches);
    const high = Math.max(...pitches);
    const mean = pitches.reduce((sum, midi) => sum + midi, 0) / pitches.length;
    const place = center + (family === "B" ? (character === "hook" ? 2 : -2) : 0);
    const shifts = [-24, -12, 0, 12].filter((shift) => high + shift <= 76 && low + shift >= 60);
    const shift = (shifts.length > 0 ? shifts : [-12]).reduce((a, b) =>
      Math.abs(mean + b - place) < Math.abs(mean + a - place) ? b : a,
    );
    let midis = pitches.map((midi) => midi + shift);
    if (transform === "octave" && midis.length > 2 && midis[1] - 12 >= 60) {
      const dropped = midis[1] - 12;
      if (Math.abs(dropped - midis[0]) <= 12 && Math.abs(dropped - (midis[2] ?? midis[0])) <= 12) {
        midis[1] = dropped;
      }
    }
    for (let guard = 0; guard < 3; guard += 1) {
      const lowNote = Math.min(...midis);
      const highNote = Math.max(...midis);
      if (lowNote >= 60 && highNote <= 76) {
        break;
      }
      if (lowNote < 60 && highNote + 12 <= 76) {
        midis = midis.map((midi) => midi + 12);
      } else if (highNote > 76 && lowNote - 12 >= 60) {
        midis = midis.map((midi) => midi - 12);
      } else {
        break;
      }
    }
    midis = midis.map((midi) => {
      let note = midi;
      while (note < 60) {
        note += 12;
      }
      while (note > 76) {
        note -= 12;
      }
      return note;
    });
    const barStart = (section.startBar + bar) * STEPS_PER_BAR;
    midis.forEach((midi, i) => {
      events.push({
        step: barStart + shape.steps[i] + delay,
        length: shape.lengths[i],
        midi,
        velocity: humanize(feel, i === 0 ? 0.7 : i === midis.length - 1 ? 0.52 : 0.6),
        nudge: lateness(feel, shape.steps[i] + delay),
      });
    });
  };

  sections.forEach((section, index) => {
    const level = peak * clamp01(section.melody);
    if (level <= 0) {
      return;
    }
    const role = sectionRole(section, index, sections);
    if (role === "breakdown") {
      emit(section, Math.min(2, section.bars - 1), "tone", "same");
      return;
    }
    if (role === "intro") {
      emit(section, section.bars > 2 ? Math.min(2, section.bars - 1) : 0, "C", "same");
      return;
    }
    const every = phraseEvery(character, level, rng);
    const offset = every <= 2 ? 1 : 1 + rng.int(0, Math.min(1, every - 2));
    for (let bar = offset; bar < section.bars; bar += every) {
      const family = role === "b" ? "B" : "A";
      let transform: MelodyTransform = "same";
      if (role === "a-var") {
        const moves: MelodyTransform[] =
          character === "hook"
            ? ["transpose", "omit", "ending", "shift", "octave"]
            : character === "modal"
              ? ["ending", "extend", "invert"]
              : ["transpose", "ending", "extend"];
        transform = rng.pick(moves);
      } else if (role === "return") {
        transform = simplifyReturn && motifNotes(motif) > 2 ? "omit" : "same";
      } else if (family === "A") {
        transform = primaryStatements === 0 ? "same" : rng.chance(0.22) ? rng.pick(["ending", "extend"] as MelodyTransform[]) : "same";
        primaryStatements += 1;
      }
      emit(section, bar, family, transform);
    }
  });

  return { events, motif, rhythm, contour, register };
}

const TRANSITION_WEIGHTS: Record<TransitionCharacter, Record<TransitionId, number>> = {
  space: {
    hold: 4,
    "bass-rest": 3,
    "hat-pickup": 2,
    "hat-fill": 0,
    ghost: 0,
    "drum-rest": 3,
    "bass-pickup": 0,
    "lead-pickup": 1,
  },
  pulse: {
    hold: 1,
    "bass-rest": 1,
    "hat-pickup": 2,
    "hat-fill": 3,
    ghost: 3,
    "drum-rest": 2,
    "bass-pickup": 2,
    "lead-pickup": 0,
  },
  drift: {
    hold: 3,
    "bass-rest": 3,
    "hat-pickup": 0,
    "hat-fill": 0,
    ghost: 0,
    "drum-rest": 3,
    "bass-pickup": 0,
    "lead-pickup": 2,
  },
};

const TRANSITION_PAIRS: ReadonlyArray<readonly [TransitionId, TransitionId]> = [
  ["hold", "drum-rest"],
  ["hold", "bass-rest"],
  ["bass-rest", "hat-pickup"],
  ["drum-rest", "lead-pickup"],
  ["drum-rest", "bass-pickup"],
  ["hat-fill", "bass-pickup"],
  ["ghost", "bass-pickup"],
  ["hold", "lead-pickup"],
];

type BoundaryKind = "intro" | "var" | "to-b" | "from-b" | "to-break" | "from-break" | "loop" | "other";

type Boundary = {
  section: PlannedSection;
  next: PlannedSection;
  nextIndex: number;
  barStart: number;
  edge: number;
  loop: boolean;
  major: boolean;
  kind: BoundaryKind;
};

function transitionBoundaries(sections: PlannedSection[], totalSteps: number): Boundary[] {
  return sections.map((section, index) => {
    const nextIndex = (index + 1) % sections.length;
    const next = sections[nextIndex];
    const loop = nextIndex === 0;
    const edge = loop ? totalSteps : next.startBar * STEPS_PER_BAR;
    let kind: BoundaryKind = "other";
    if (loop) {
      kind = "loop";
    } else if (section.kind === "intro") {
      kind = "intro";
    } else if (section.kind === "breakdown") {
      kind = "from-break";
    } else if (next.kind === "breakdown") {
      kind = "to-break";
    } else if (next.kind === "b") {
      kind = "to-b";
    } else if (section.kind === "b") {
      kind = "from-b";
    } else if (Boolean(section.variation) !== Boolean(next.variation)) {
      kind = "var";
    }
    return {
      section,
      next,
      nextIndex,
      barStart: edge - STEPS_PER_BAR,
      edge,
      loop,
      major: kind !== "var" && kind !== "other",
      kind,
    };
  });
}

function chordBed(chords: ChordEvent[], from: number, to: number) {
  return chords.some((chord) => chord.step < to && chord.step + chord.length + 6 > from);
}

function dropHits(drums: DrumHit[], from: number, to: number, kinds: ReadonlyArray<DrumHit["kind"]>) {
  let removed = 0;
  for (const hit of drums) {
    if (hit.velocity > 0 && hit.step >= from && hit.step < to && kinds.includes(hit.kind)) {
      hit.velocity = 0;
      removed += 1;
    }
  }
  return removed;
}

function hatAt(drums: DrumHit[], step: number) {
  return drums.some((hit) => hit.step === step && (hit.kind === "hat" || hit.kind === "openHat"));
}

function pickTransition(rng: Rng, weights: Record<TransitionId, number>, blocked: ReadonlySet<TransitionId>) {
  const entries = (Object.entries(weights) as [TransitionId, number][]).filter(
    ([id, weight]) => weight > 0 && !blocked.has(id),
  );
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) {
    return null;
  }
  let roll = rng.next() * total;
  for (const [id, weight] of entries) {
    roll -= weight;
    if (roll < 0) {
      return id;
    }
  }
  return entries[entries.length - 1][0];
}

/**
 * Dresses section boundaries after the arrangement is written. Its random stream is
 * separate, so form, harmony, melody vocabulary, and the groove stay on their seeds.
 */
function applyTransitions(
  profile: MusicProfile,
  scale: readonly number[],
  keyPc: number,
  sections: PlannedSection[],
  chords: ChordEvent[],
  bass: NoteEvent[],
  melody: NoteEvent[],
  drums: DrumHit[],
  rng: Rng,
): TransitionMark[] {
  const plan = profile.transitions;
  if (!plan || plan.rate <= 0 || sections.length < 2) {
    return [];
  }
  const weights = TRANSITION_WEIGHTS[plan.character];
  const totalSteps = sections.reduce((sum, section) => sum + section.bars, 0) * STEPS_PER_BAR;
  const marks: TransitionMark[] = [];
  const vel = (base: number) => Math.min(0.85, base * (0.92 + rng.next() * 0.16));

  const apply = (boundary: Boundary, kind: TransitionId): boolean => {
    const { section, next, nextIndex, barStart, edge, loop, kind: boundaryKind } = boundary;
    const arrival = loop ? 0 : next.startBar * STEPS_PER_BAR;

    if (kind === "hold") {
      let chord: ChordEvent | null = null;
      for (const candidate of chords) {
        if (candidate.step < edge && candidate.step + candidate.length >= barStart) {
          if (!chord || candidate.step >= chord.step) {
            chord = candidate;
          }
        }
      }
      if (!chord) {
        return false;
      }
      const extend = Math.min(4, Math.max(0, edge + 4 - (chord.step + chord.length)));
      if (extend > 0) {
        chord.length += extend;
      }
      chord.release = Math.min(1.8, chord.release + 0.35);
      return true;
    }

    if (kind === "bass-rest") {
      if (!chordBed(chords, barStart + 8, edge)) {
        return false;
      }
      const cut = barStart + 8;
      let changed = false;
      for (let i = bass.length - 1; i >= 0; i -= 1) {
        const note = bass[i];
        const end = note.step + note.length;
        if (end <= cut || note.step >= edge) {
          continue;
        }
        if (note.velocity <= 0) {
          continue;
        }
        if (note.step >= cut || cut - note.step < 2) {
          note.velocity = 0;
        } else {
          note.length = cut - note.step;
        }
        changed = true;
      }
      return changed;
    }

    if (kind === "hat-pickup" || kind === "hat-fill") {
      if (next.kind === "breakdown" || (section.drums <= 0 && next.drums <= 0)) {
        return false;
      }
      if (kind === "hat-fill" && (section.drums < 0.5 || drums.some((hit) => hit.kind === "snare" && hit.step >= barStart + 14 && hit.step < edge))) {
        return false;
      }
      const steps = kind === "hat-fill" ? [barStart + 9, barStart + 11] : [barStart + 12, barStart + 14];
      let added = 0;
      for (const step of steps) {
        if (step < 0 || step >= totalSteps || hatAt(drums, step)) {
          continue;
        }
        drums.push({
          step,
          kind: "hat",
          velocity: vel(kind === "hat-fill" ? 0.3 : 0.2),
          nudge: rng.next() * 0.004,
        });
        added += 1;
      }
      return added > 0;
    }

    if (kind === "ghost") {
      if (next.kind === "breakdown" || section.drums < 0.5) {
        return false;
      }
      const step = barStart + 15;
      if (drums.some((hit) => hit.kind === "snare" && hit.step >= barStart + 14 && hit.step <= step)) {
        return false;
      }
      drums.push({ step, kind: "snare", velocity: vel(0.22), nudge: rng.next() * 0.004 });
      return true;
    }

    if (kind === "drum-rest") {
      if (boundaryKind === "to-break") {
        if (!chordBed(chords, barStart, edge)) {
          return false;
        }
        const removed =
          dropHits(drums, barStart, edge, ["kick"]) + dropHits(drums, barStart + 8, edge, ["hat", "openHat"]);
        return removed > 0;
      }
      const repeated =
        next.kind === "a" && sections.some((item, index) => index < nextIndex && item.kind === "a");
      if ((boundaryKind === "from-b" || boundaryKind === "var") && repeated && chordBed(chords, arrival, arrival + 16)) {
        const muteHats = () => dropHits(drums, arrival, arrival + STEPS_PER_BAR, ["hat", "openHat"]) > 0;
        const muteLead = () => {
          let removed = 0;
          for (const note of melody) {
            if (note.velocity > 0 && note.step >= arrival && note.step < arrival + STEPS_PER_BAR) {
              note.velocity = 0;
              removed += 1;
            }
          }
          return removed > 0;
        };
        const thinBass = () => {
          const inBar = bass.filter(
            (note) => note.velocity > 0 && note.step >= arrival && note.step < arrival + STEPS_PER_BAR,
          );
          if (inBar.length < 2) {
            return false;
          }
          inBar.sort((a, b) => a.step - b.step);
          for (const note of inBar.slice(1)) {
            note.velocity = 0;
          }
          return true;
        };
        const roll = rng.next();
        if (roll < 0.34) {
          return muteHats() || muteLead();
        }
        if (roll < 0.67) {
          return muteLead() || muteHats();
        }
        return thinBass() || muteHats();
      }
      if (!chordBed(chords, barStart + 12, edge)) {
        return false;
      }
      const removed = dropHits(drums, barStart + 12, edge, ["kick"]);
      if (removed === 0) {
        return dropHits(drums, barStart + 8, edge, ["hat", "openHat"]) > 0;
      }
      const kick = drums.find((hit) => hit.kind === "kick" && hit.step === arrival);
      if (kick) {
        kick.velocity = Math.min(1.12, kick.velocity * 1.08);
      }
      return true;
    }

    if (kind === "bass-pickup") {
      if (next.bass <= 0) {
        return false;
      }
      const overlaps = (step: number, length: number) =>
        bass.some((note) => note.velocity > 0 && note.step < step + length && note.step + note.length > step);
      let step = barStart + 12;
      let length = 4;
      if (overlaps(step, length)) {
        step = barStart + 14;
        length = 2;
        if (overlaps(step, length)) {
          return false;
        }
      }
      const degree = next.degrees[0];
      const current = section.degrees[section.bars - 1];
      let midi =
        degree === current
          ? bassRoot(keyPc, scale, degree)
          : bassRoot(keyPc, scale, degree) -
            (degreeToSemitones(scale, degree) - degreeToSemitones(scale, degree - 1));
      while (midi < 34) {
        midi += 12;
      }
      while (midi > 48) {
        midi -= 12;
      }
      bass.push({ step, length, midi, velocity: vel(0.55), nudge: rng.next() * 0.004 });
      return true;
    }

    if (kind === "lead-pickup") {
      if (next.melody <= 0) {
        return false;
      }
      const chord =
        chords.find((item) => item.step === arrival) ??
        chords.find((item) => item.step >= arrival && item.step < arrival + STEPS_PER_BAR);
      if (!chord) {
        return false;
      }
      let midi = chord.notes[chord.notes.length - 1];
      while (midi < 60) {
        midi += 12;
      }
      while (midi > 76) {
        midi -= 12;
      }
      const step = barStart + 14;
      if (melody.some((note) => note.velocity > 0 && note.step < step + 2 && note.step + note.length > step - 1)) {
        return false;
      }
      melody.push({ step, length: 2, midi, velocity: vel(0.42), nudge: rng.next() * 0.004 });
      return true;
    }

    return false;
  };

  const blockedFor = (boundary: Boundary) => {
    const blocked = new Set<TransitionId>();
    if (boundary.kind === "to-break") {
      blocked.add("hat-pickup");
      blocked.add("hat-fill");
      blocked.add("ghost");
      blocked.add("bass-pickup");
      blocked.add("lead-pickup");
    }
    if (boundary.kind === "from-break") {
      blocked.add("hat-fill");
      blocked.add("ghost");
      blocked.add("drum-rest");
    }
    if (boundary.kind === "intro" || boundary.kind === "loop") {
      blocked.add("hat-fill");
      blocked.add("ghost");
    }
    return blocked;
  };

  for (const boundary of transitionBoundaries(sections, totalSteps)) {
    const chance = plan.rate * (boundary.major ? 1 : 0.45);
    if (!rng.chance(chance)) {
      continue;
    }
    const blocked = blockedFor(boundary);
    let kind = pickTransition(rng, weights, blocked);
    if (!kind) {
      continue;
    }
    if (!apply(boundary, kind)) {
      blocked.add(kind);
      kind = pickTransition(rng, weights, blocked);
      if (!kind || !apply(boundary, kind)) {
        continue;
      }
    }
    marks.push({ step: boundary.edge, kind });
    if (boundary.major && rng.chance(0.16)) {
      const pairs = new Set<TransitionId>();
      for (const [left, right] of TRANSITION_PAIRS) {
        if (left === kind) {
          pairs.add(right);
        }
        if (right === kind) {
          pairs.add(left);
        }
      }
      blocked.add(kind);
      for (const id of Object.keys(weights) as TransitionId[]) {
        if (!pairs.has(id)) {
          blocked.add(id);
        }
      }
      const second = pickTransition(rng, weights, blocked);
      if (second && apply(boundary, second)) {
        marks.push({ step: boundary.edge, kind: second });
      }
    }
  }

  return marks;
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
  const chosenForm = pickForm(profile, rng);
  const homeForm = chosenForm === profile.form;
  const grooveId = rng.pick(groovePool(profile.density.drums));
  const basses = bassPool(profile.density.bass);
  const bassChoices = busyGroove(grooveId) ? basses.filter((id) => CALM_BASS.has(id)) : basses;
  const bassId = rng.pick(bassChoices.length > 0 ? bassChoices : basses);
  const openVoicing = homeForm && !busyGroove(grooveId) && rng.chance(0.45);
  const progression = rng.pick(profile.progressions);
  const others = profile.progressions.filter((p) => p !== progression);
  const bridge = others.length > 0 ? rng.pick(others) : progression;
  const sections = planForm(profile, PROGRESSIONS[progression], PROGRESSIONS[bridge], chosenForm, rng);

  // Same draws as the previous chord pass, so form, groove, bass, and motif stay put.
  buildChords(profile, scale, keyPc, sections, rng, feel, openVoicing);
  const harm = createRng((seed ^ 0x6c8e9cf5) >>> 0);
  const harmonic = applyHarmonicRhythm(sections, profile, harm);
  const harmony = renderHarmony(profile, scale, keyPc, sections, harm, {
    rng: createRng((seed ^ 0x4b1d3c2a) >>> 0),
    timing: feel.timing,
    velocity: feel.velocity,
  }, openVoicing, harmonic, createRng((seed ^ 0x3c6ef372) >>> 0), bassId);
  const chords = harmony.events;
  const bass = buildBass(profile, scale, keyPc, sections, rng, feel, bassId);
  // The previous melody pass still draws, so the drum stream stays where it was.
  buildMelody(profile, scale, keyPc, sections, rng, feel, homeForm && !busyGroove(grooveId));
  const sung = renderMelody(profile, scale, keyPc, sections, chords, createRng((seed ^ 0x1b873593) >>> 0), {
    rng: createRng((seed ^ 0xcc9e2d51) >>> 0),
    timing: feel.timing,
    velocity: feel.velocity,
  });
  const melody = sung.events;
  const drums = buildDrums(profile, sections, rng, feel, grooveId);
  const transitions = applyTransitions(
    profile,
    scale,
    keyPc,
    sections,
    chords,
    bass,
    melody,
    drums,
    createRng((seed ^ 0xa24baed1) >>> 0),
  );
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
    form: sections.map((s) => `${SECTION_LABEL[s.kind]}${s.variation ? "'" : ""}${s.bars}`).join(" "),
    arrangement: {
      groove: grooveId,
      bass: bassId,
      voicing: openVoicing ? "open" : "close",
      harmonic,
      melody: { motif: sung.motif, rhythm: sung.rhythm, contour: sung.contour, register: sung.register },
      color: harmony.plan,
    },
    chordColors: harmony.colors,
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
    transitions,
  };
}

export function describeComposition(c: Composition) {
  const bars = c.steps / STEPS_PER_BAR;
  const color = c.arrangement.color;
  return `seed=${c.seed} ${c.bpm}bpm ${c.key} ${c.scale} [${c.progression} | B ${c.bridge}] ${c.chordNames.join(" ")} · ${c.arrangement.groove}/${c.arrangement.bass}/${c.arrangement.harmonic} · ${color.primary}/${color.secondary}/${color.accent}${color.substitution === "none" ? "" : `+${color.substitution}`} · ${c.arrangement.melody.motif}/${c.arrangement.melody.register} · ${bars} bars: ${c.form}`;
}
