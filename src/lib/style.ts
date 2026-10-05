import type { CSSProperties } from "react";
import type { Rgb } from "@/worlds/types";

/** Inline style that may also set CSS custom properties. */
export type StyleWithVars = CSSProperties & Record<`--${string}`, string>;

/** Formats a color as the "r, g, b" triplet CSS uses inside `rgba(var(--x), a)`. */
export function rgbTriplet([r, g, b]: Rgb) {
  return `${r}, ${g}, ${b}`;
}
