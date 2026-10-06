import type { NoteName, ScaleName, WorldId } from "@/worlds/types";

/** What the HUD shows for the composition that is playing, or queued while paused. */
export type NowPlayingInfo = {
  worldId: WorldId;
  seed: number;
  tempo: number;
  root: NoteName;
  scale: ScaleName;
};

const SCALE_LABEL: Record<ScaleName, string> = {
  major: "Major",
  lydian: "Lydian",
  mixolydian: "Mixolydian",
  dorian: "Dorian",
  /** Natural minor. Not a major scale that shares a key signature. */
  aeolian: "Minor",
};

/** Six uppercase hex characters. Presentation only: it never feeds composition. */
export function signalId(seed: number) {
  let value = seed >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  value = (value ^ (value >>> 16)) >>> 0;
  return value.toString(16).toUpperCase().padStart(8, "0").slice(0, 6);
}

/** "72 BPM · D Major", "74 BPM · D Dorian", "88 BPM · F# Minor". */
export function formatTempoKey(info: Pick<NowPlayingInfo, "tempo" | "root" | "scale">) {
  return `${info.tempo} BPM · ${info.root} ${SCALE_LABEL[info.scale]}`;
}
