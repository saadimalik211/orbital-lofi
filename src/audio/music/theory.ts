import type { MusicProfile, NoteName, ProgressionId, ScaleName } from "@/worlds/types";

export const NOTE_NAMES: readonly NoteName[] = [
  "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
];

export const SCALES: Record<ScaleName, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};

/** 0-based scale degrees, one chord per entry. Diatonic, so they fit any of the modes above. */
export const PROGRESSIONS: Record<ProgressionId, readonly number[]> = {
  "1-4-1-4": [0, 3, 0, 3],
  "1-6-2-5": [0, 5, 1, 4],
  "2-5-1-6": [1, 4, 0, 5],
  "4-3-2-1": [3, 2, 1, 0],
  "1-6-3-7": [0, 5, 2, 6],
  "1-4-7-3": [0, 3, 6, 2],
  "1-7-6-7": [0, 6, 5, 6],
  "1-4-5-1": [0, 3, 4, 0],
};

export type ChordStyle = MusicProfile["chords"]["style"];

const mod = (value: number, size: number) => ((value % size) + size) % size;

export function noteIndex(name: NoteName) {
  return NOTE_NAMES.indexOf(name);
}

/** Semitones above the key root for a (possibly negative or >7) scale degree. */
export function degreeToSemitones(scale: readonly number[], degree: number) {
  return scale[mod(degree, 7)] + 12 * Math.floor(degree / 7);
}

/** Chord built by stacking scale thirds on `degree`, as semitones above the key root. */
export function chordSemitones(scale: readonly number[], degree: number, style: ChordStyle) {
  const notes = (stack: number[]) => stack.map((step) => degreeToSemitones(scale, degree + step));
  if (style === "triad") {
    return notes([0, 2, 4]);
  }
  const ninth = notes([0, 2, 6, 8]);
  // A ninth a half step above the root (iii/vii in major, ii in minor) clashes: use the seventh.
  return style === "seventh" || mod(ninth[3] - ninth[0], 12) === 1 ? notes([0, 2, 4, 6]) : ninth;
}

const VOICING_LOW = 50;
const VOICING_HIGH = 79;
const VOICING_CENTER = 62;

/**
 * Picks the inversion/octave of a chord (given as pitch classes, root first) that stays in a
 * mid register and moves least from the previous voicing, so changes never jump octaves.
 * `avoid` skips one voicing, giving the next-closest inversion (used to vary repeats).
 */
export function voiceChord(
  pitchClasses: readonly number[],
  previous: readonly number[] | null,
  avoid?: readonly number[],
) {
  let best: number[] = [];
  let bestScore = Infinity;
  for (let inversion = 0; inversion < pitchClasses.length; inversion += 1) {
    const order = [...pitchClasses.slice(inversion), ...pitchClasses.slice(0, inversion)];
    for (let octave = 4; octave <= 6; octave += 1) {
      const notes: number[] = [];
      let floor = octave * 12 + order[0] - 12;
      for (const pc of order) {
        let midi = Math.floor(floor / 12) * 12 + pc;
        if (midi < floor) {
          midi += 12;
        }
        notes.push(midi);
        floor = midi + 1;
      }
      if (notes[0] < VOICING_LOW || notes[notes.length - 1] > VOICING_HIGH) {
        continue;
      }
      if (avoid && notes.length === avoid.length && notes.every((note, i) => note === avoid[i])) {
        continue;
      }
      const score = previous
        ? notes.reduce((sum, note, i) => sum + Math.abs(note - (previous[i] ?? note)), 0)
        : Math.abs(notes.reduce((a, b) => a + b, 0) / notes.length - VOICING_CENTER);
      if (score < bestScore) {
        bestScore = score;
        best = notes;
      }
    }
  }
  return best;
}

/** Human-readable chord symbol (dev logging only), e.g. "Dm7", "Fmaj9", "G7". */
export function chordName(rootPc: number, semitones: readonly number[]) {
  const rel = semitones.map((s) => mod(s - semitones[0], 12));
  const third = rel.includes(3) ? "m" : "";
  const dim = rel.includes(6) && third ? "dim" : "";
  const seventh = rel.includes(11) ? "maj7" : rel.includes(10) ? "7" : "";
  const ninth = rel.includes(2) ? (seventh ? seventh.replace("7", "9") : "add9") : seventh;
  const quality = dim && seventh === "7" ? "m7b5" : dim ? "dim" : `${third}${ninth}`;
  return `${NOTE_NAMES[mod(rootPc, 12)]}${quality}`;
}
