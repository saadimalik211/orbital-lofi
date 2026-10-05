"use client";

import { useEffect, useRef } from "react";
import { createEffectsRenderer } from "@/effects/createEffectsRenderer";
import { useReducedMotion } from "@/effects/useReducedMotion";
import type { StyleWithVars } from "@/lib/styleVars";
import type { WorldEffects } from "@/worlds/types";

type EnvironmentalEffectsProps = {
  effects: WorldEffects;
};

export function EnvironmentalEffects({ effects }: EnvironmentalEffectsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const fog = effects.fog?.intensity ?? 0;
  const flicker = effects.flicker?.intensity ?? 0;
  const flickerStyle = effects.flicker?.style ?? "screen";
  const flickerVars: StyleWithVars = { "--env-flicker": String(0.035 + flicker * 0.06) };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    return createEffectsRenderer(canvas, effects, reducedMotion);
  }, [effects, reducedMotion]);

  return (
    <div className="env-layer" aria-hidden>
      <canvas ref={canvasRef} className="env-canvas" />
      {fog > 0 ? (
        <div
          className={`env-fog${reducedMotion ? " env-fog-still" : ""}`}
          style={{ opacity: 0.22 + fog * 0.38 }}
        />
      ) : null}
      {flicker > 0 && !reducedMotion ? (
        <div
          className={`env-flicker env-flicker-${flickerStyle}`}
          style={flickerVars}
        />
      ) : null}
    </div>
  );
}
