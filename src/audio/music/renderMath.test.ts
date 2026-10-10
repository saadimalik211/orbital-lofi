import {
  foldTail,
  isCurrentGeneration,
  loopOffset,
  nextBarHandoff,
  pieceSeconds,
  pieceTailSeconds,
  renderPace,
} from "./renderMath";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function close(actual: number, expected: number, slop: number, message: string) {
  assert(Math.abs(actual - expected) <= slop, `${message}: ${actual} vs ${expected}`);
}

export function runRenderMathTests() {
  const pace = renderPace(79200, 143.6);
  if (!pace) {
    throw new Error("pace exists");
  }
  close(pace.factor, 79.2 / 143.6, 1e-9, "render factor is wall time over audio length");
  close(pace.realtime, 143.6 / 79.2, 1e-9, "realtime rate is the inverse");
  assert(renderPace(0, 10) == null, "a zero wall time is not a pace");

  assert(isCurrentGeneration(4, 4), "matching generation is current");
  assert(!isCurrentGeneration(4, 5), "a newer generation makes the render stale");

  const neon = pieceTailSeconds({ decay: 1.35, softness: 0.3 });
  const orbital = pieceTailSeconds({ decay: 3.4, softness: 0.85 });
  const centauri = pieceTailSeconds({ decay: 4.2, softness: 0.62 });
  close(neon, 3.1, 0.25, "neon tail");
  close(orbital, 5.0, 0.25, "orbital tail");
  close(centauri, 5.8, 0.25, "centauri tail");
  assert(neon < orbital && orbital < centauri, "longer rooms keep a longer tail");

  const piece = pieceSeconds(60, 16 * 4);
  close(piece, 16, 1e-6, "four bars at 60 bpm");
  const early = nextBarHandoff(1, piece, 4, 10, 0.08);
  close(early.wait, 3, 1e-6, "wait until the next bar");
  close(early.offset, 4, 1e-6, "offset lands on that bar");
  close(early.audioTime, 13, 1e-6, "handoff uses the audio clock");

  const tight = nextBarHandoff(3.95, piece, 4, 10, 0.08);
  close(tight.wait, 4.05, 1e-6, "a boundary inside the lead skips to the next bar");
  close(tight.offset, 8, 1e-6, "skipped bar still lands on a bar line");

  const wrapped = nextBarHandoff(15.5, piece, 4, 50, 0.08);
  close(wrapped.wait, 0.5, 1e-6, "the loop point is a bar line");
  close(wrapped.offset, 0, 1e-6, "a boundary on the loop restarts at 0");

  close(loopOffset(20.1, 100, 100, 184.2), 20.1, 1e-6, "resume starts at the paused offset");
  close(loopOffset(20.1, 100, 110, 184.2), 30.1, 1e-6, "elapsed audio time advances the offset");
  close(loopOffset(20.1, 100, 99, 184.2), 20.1, 1e-6, "before the source starts, the offset stays put");
  close(loopOffset(20.1, 100, 100 + 184.2, 184.2), 20.1, 1e-9, "the offset wraps with the piece");

  const head = new Float32Array([0.2, 0.2, 0.2, 0.2]);
  const tail = new Float32Array([0.4, 0.2, 0]);
  const folded = foldTail(head, tail);
  assert(folded.samples.length === head.length, "the loop buffer is the piece length");
  close(folded.samples[0], 0.6, 1e-6, "the tail starts at full level on the first sample");
  close(folded.samples[1], 0.2 + 0.2 * Math.cos((1 / 3) * (Math.PI / 2)), 1e-5, "the tail fades across the overlap");
  close(folded.samples[3], 0.2, 1e-6, "samples past the tail stay untouched");

  const hot = foldTail(new Float32Array([0.9, 0.2]), new Float32Array([0.9]));
  assert(hot.peak <= 0.98 + 1e-6, "folding scales a clip back under full scale");
  assert(hot.scaled, "a hot overlap is marked scaled");
  assert(Math.abs(hot.samples[0]) <= 0.98 + 1e-6, "the overlapped sample itself is limited");
}

runRenderMathTests();
console.log("renderMath tests passed");
