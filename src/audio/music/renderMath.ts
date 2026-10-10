/**
 * Pure timing and loop math for rendered procedural playback.
 * The composer and the synth do not live here.
 */

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Seconds from the downbeat of step 0 to the downbeat where the score loops. */
export function pieceSeconds(bpm: number, steps: number) {
  if (!(bpm > 0) || !(steps > 0)) {
    return 0;
  }
  return steps * (60 / bpm / 4);
}

export function barSeconds(bpm: number) {
  if (!(bpm > 0)) {
    return 0;
  }
  return (60 / bpm) * 4;
}

/**
 * How long the render continues past the loop point so releases and the reverb
 * tail can be folded back into the start. Derived from softness and reverb decay.
 */
export function pieceTailSeconds(input: { decay: number; softness: number }) {
  const softness = clamp01(input.softness);
  const noteRelease = (0.45 + softness * 0.85) * 1.8 * 1.2;
  const decay = Math.max(0, input.decay);
  return Math.min(8, Math.max(decay, noteRelease) + 1.6);
}

export type BarHandoff = {
  /** Seconds from `audioNow` until the boundary. */
  wait: number;
  /** Audio-context time of the boundary. */
  audioTime: number;
  /** Offset into the rendered piece, in seconds. */
  offset: number;
};

/**
 * The next bar line that is still far enough ahead to schedule.
 * The offset wraps with the piece, so a boundary on the loop point is 0.
 */
export function nextBarHandoff(
  musicalSeconds: number,
  piece: number,
  bar: number,
  audioNow: number,
  minLead = 0.08,
): BarHandoff {
  if (!(piece > 0) || !(bar > 0)) {
    const audioTime = audioNow + minLead;
    return { wait: minLead, audioTime, offset: 0 };
  }
  const m = ((musicalSeconds % piece) + piece) % piece;
  const into = m % bar;
  let wait = into < 1e-4 ? bar : bar - into;
  if (wait < minLead) {
    wait += bar;
  }
  let offset = m + wait;
  if (offset >= piece - 1e-4) {
    const untilEnd = piece - m;
    if (untilEnd >= minLead) {
      wait = untilEnd;
      offset = 0;
    } else {
      wait = untilEnd + bar;
      offset = bar >= piece ? 0 : bar;
    }
  }
  return { wait, audioTime: audioNow + wait, offset };
}

/** A finished render may start only when its generation is still the one playing. */
export function isCurrentGeneration(started: number, current: number) {
  return started === current;
}

/** Position inside a looping buffer. Before the source starts, this is the start offset. */
export function loopOffset(startOffset: number, startedAt: number, now: number, piece: number) {
  if (!(piece > 0)) {
    return 0;
  }
  const elapsed = now - startedAt;
  const raw = startOffset + (elapsed > 0 ? elapsed : 0);
  return ((raw % piece) + piece) % piece;
}

/**
 * Fold the rendered tail onto the head with a cosine fade, then scale if the
 * sum would clip. `piece` is the musical cycle. `tail` is what was rendered after it.
 */
export function foldTail(piece: Float32Array, tail: Float32Array, limit = true) {
  const out = new Float32Array(piece);
  const span = Math.min(tail.length, out.length);
  let peak = 0;
  for (let i = 0; i < span; i += 1) {
    const fade = Math.cos((i / span) * (Math.PI / 2));
    out[i] += tail[i] * fade;
  }
  for (let i = 0; i < out.length; i += 1) {
    peak = Math.max(peak, Math.abs(out[i]));
  }
  let scaled = false;
  if (limit && peak > 0.98) {
    const gain = 0.98 / peak;
    for (let i = 0; i < out.length; i += 1) {
      out[i] *= gain;
    }
    scaled = true;
    peak = 0.98;
  }
  return { samples: out, peak, scaled };
}
