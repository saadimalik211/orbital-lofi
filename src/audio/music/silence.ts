import { STEPS_PER_BAR, type ChordEvent, type Composition, type DrumHit, type NoteEvent } from "@/audio/music/composer";

/**
 * Dev-only view of silence that is already written into a composition.
 * The scheduler, humanization, and note cleanup are not involved: nudges stay under 30ms.
 * Texture is a constant bed, so it is not counted as a musical event.
 */

export type SilenceCause = "chord-breath" | "missing-harmony" | "pulse-spacing" | "section-rest" | "layer-rest";

export type SilenceSpan = {
  seconds: number;
  section: string;
  cause: SilenceCause;
};

export type SilenceReport = {
  bars: number;
  /** Bars that contain no note onset. A sustaining chord still counts as an onset only on its first bar. */
  barsWithoutOnset: number;
  /** Bars where nothing is still sounding. */
  barsWithNoSound: number;
  longestSilence: SilenceSpan | null;
  longestWithoutChord: SilenceSpan | null;
  longestWithoutRhythm: SilenceSpan | null;
  /** Complete-silence spans long enough to hear as a pause. */
  silences: SilenceSpan[];
  source: "score";
};

type Span = { start: number; end: number };

const HEARD_SILENCE_S = 0.5;

function merge(spans: Span[]): Span[] {
  const sorted = spans.filter((span) => span.end > span.start + 1e-4).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end + 1e-3) {
      last.end = Math.max(last.end, span.end);
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/** Musical tail after the written end. Chords use the keys release in `instruments.ts`; half of it stays audible. */
function chordTail(composition: Composition, chord: ChordEvent) {
  const release = (0.45 + composition.space.softness * 0.85) * chord.release;
  return release * 0.5;
}

function place(loop: number, start: number, duration: number, into: Span[]) {
  const at = ((start % loop) + loop) % loop;
  if (at + duration <= loop) {
    into.push({ start: at, end: at + duration });
    return;
  }
  into.push({ start: at, end: loop });
  const rest = at + duration - loop;
  if (rest > 1e-4) {
    into.push({ start: 0, end: rest });
  }
}

function holes(covered: Span[], loop: number): Span[] {
  if (covered.length === 0) {
    return [{ start: 0, end: loop }];
  }
  const gaps: Span[] = [];
  for (let i = 0; i < covered.length; i += 1) {
    const next = covered[(i + 1) % covered.length];
    const start = covered[i].end;
    const end = i === covered.length - 1 ? next.start + loop : next.start;
    if (end - start > 1e-3) {
      gaps.push({ start: start % loop, end: end - start });
    }
  }
  return gaps;
}

function sectionAt(composition: Composition, step: number) {
  const at = ((step % composition.steps) + composition.steps) % composition.steps;
  let kind = composition.sections[0]?.kind ?? "intro";
  let origin = 0;
  for (const section of composition.sections) {
    if (section.step <= at) {
      kind = section.kind;
      origin = section.step;
    }
  }
  return `${kind} bar ${Math.floor(origin / STEPS_PER_BAR) + 1}`;
}

function sectionRange(composition: Composition, step: number) {
  const at = ((step % composition.steps) + composition.steps) % composition.steps;
  let start = 0;
  let end = composition.steps;
  for (let i = 0; i < composition.sections.length; i += 1) {
    if (composition.sections[i].step <= at) {
      start = composition.sections[i].step;
      end = composition.sections[i + 1]?.step ?? composition.steps;
    }
  }
  return { start, end };
}

function pulsePiece(chords: ChordEvent[]) {
  return chords.length > 0 && chords.every((chord) => chord.length <= 8);
}

function classifyChordHole(composition: Composition, seconds: number, sixteenth: number): SilenceCause {
  if (seconds <= sixteenth * 2) {
    return "chord-breath";
  }
  return pulsePiece(composition.chords) ? "pulse-spacing" : "missing-harmony";
}

function rhythmInSection(composition: Composition, step: number) {
  const { start, end } = sectionRange(composition, step);
  const inside = (eventStep: number) => eventStep >= start && eventStep < end;
  return composition.bass.some((note) => inside(note.step)) || composition.drums.some((hit) => inside(hit.step));
}

export function analyzeSilence(composition: Composition): SilenceReport {
  const sixteenth = 60 / composition.bpm / 4;
  const loop = composition.steps * sixteenth;
  const melodyTail = 0.14 + composition.space.softness * 0.15;
  const chords: Span[] = [];
  const rhythm: Span[] = [];
  const all: Span[] = [];

  const add = (into: Span[], step: number, seconds: number) => {
    place(loop, step * sixteenth, seconds, into);
  };

  for (const chord of composition.chords) {
    const seconds = chord.length * sixteenth + chordTail(composition, chord);
    add(chords, chord.step, seconds);
    add(all, chord.step, seconds);
  }
  for (const note of composition.bass) {
    const seconds = note.length * sixteenth + 0.12;
    add(rhythm, note.step, seconds);
    add(all, note.step, seconds);
  }
  for (const note of composition.melody) {
    add(all, note.step, note.length * sixteenth + melodyTail);
  }
  for (const hit of composition.drums) {
    const seconds = hit.kind === "hat" || hit.kind === "openHat" ? 0.04 : 0.14;
    add(rhythm, hit.step, seconds);
    add(all, hit.step, seconds);
  }

  const toSpan = (gap: Span, cause: SilenceCause): SilenceSpan => ({
    seconds: gap.end,
    section: sectionAt(composition, Math.floor(((gap.start % loop) + loop) % loop / sixteenth)),
    cause,
  });

  const chordGaps = holes(merge(chords), loop).map((gap) =>
    toSpan(gap, classifyChordHole(composition, gap.end, sixteenth)),
  );
  const rhythmGaps = holes(merge(rhythm), loop).map((gap) =>
    toSpan(gap, rhythmInSection(composition, Math.floor(gap.start / sixteenth)) ? "layer-rest" : "section-rest"),
  );
  const silent = holes(merge(all), loop).map((gap) => {
    const step = Math.floor((((gap.start % loop) + loop) % loop) / sixteenth);
    const harmonic = classifyChordHole(composition, gap.end, sixteenth);
    const cause: SilenceCause =
      harmonic === "chord-breath"
        ? "chord-breath"
        : harmonic === "pulse-spacing"
          ? "pulse-spacing"
          : rhythmInSection(composition, step)
            ? "missing-harmony"
            : "section-rest";
    return toSpan(gap, cause);
  });

  const longest = (spans: SilenceSpan[]) =>
    spans.reduce<SilenceSpan | null>((best, span) => (!best || span.seconds > best.seconds ? span : best), null);

  let barsWithoutOnset = 0;
  let barsWithNoSound = 0;
  const sounding = merge(all);
  const bars = composition.steps / STEPS_PER_BAR;
  for (let bar = 0; bar < bars; bar += 1) {
    const from = bar * STEPS_PER_BAR;
    const to = from + STEPS_PER_BAR;
    const onset = [...composition.chords, ...composition.bass, ...composition.melody, ...composition.drums].some(
      (event: ChordEvent | NoteEvent | DrumHit) => event.step >= from && event.step < to,
    );
    if (!onset) {
      barsWithoutOnset += 1;
    }
    const start = from * sixteenth;
    const end = to * sixteenth;
    const heard = sounding.some((span) => span.start < end && span.end > start);
    if (!heard) {
      barsWithNoSound += 1;
    }
  }

  return {
    bars,
    barsWithoutOnset,
    barsWithNoSound,
    longestSilence: longest(silent),
    longestWithoutChord: longest(chordGaps),
    longestWithoutRhythm: longest(rhythmGaps),
    silences: silent.filter((span) => span.seconds >= HEARD_SILENCE_S).sort((a, b) => b.seconds - a.seconds),
    source: "score",
  };
}

function line(label: string, span: SilenceSpan | null) {
  if (!span) {
    return `${label}: none`;
  }
  return `${label}: ${span.seconds.toFixed(2)}s in ${span.section} (${span.cause})`;
}

/** One block for the dev console. Safe to ignore in production; nothing in the HUD reads it. */
export function describeSilence(composition: Composition) {
  const report = analyzeSilence(composition);
  const heard = report.silences
    .slice(0, 6)
    .map((span) => `    ${span.seconds.toFixed(2)}s ${span.section} ${span.cause}`)
    .join("\n");
  return [
    `silence ${composition.seed} [${report.source}]`,
    `  bars with no onset ${report.barsWithoutOnset}/${report.bars}, bars with no sound ${report.barsWithNoSound}/${report.bars}`,
    `  ${line("longest silence", report.longestSilence)}`,
    `  ${line("longest without a chord", report.longestWithoutChord)}`,
    `  ${line("longest without rhythm", report.longestWithoutRhythm)}`,
    heard ? `  spans over ${HEARD_SILENCE_S}s:\n${heard}` : "  no silence over 0.5s",
  ].join("\n");
}
