import type { CSSProperties } from "react";
import type { Rgb } from "@/worlds/types";

/** Inline style that may also set CSS custom properties. */
export type StyleWithVars = CSSProperties & Record<`--${string}`, string>;

/** `[r, g, b]` → `"r, g, b"` for use inside `rgba(var(--x), a)`. */
export function rgbVar(color: Rgb) {
  return color.join(", ");
}
