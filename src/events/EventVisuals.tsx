"use client";

import { useState } from "react";
import { rgbVar, type StyleWithVars } from "@/lib/styleVars";
import type { FlybyEvent, PulseEvent, Rgb, StreakEvent } from "@/worlds/types";

const DEFAULT_FLYBY_LIGHT: Rgb = [200, 230, 255];
const missingAssets = new Set<string>();

export type FlybyPlacement = { top: number; direction: "ltr" | "rtl" };
export type StreakPlacement = { left: number; top: number };

type Timed = { duration: number };

export function FlybyVisual({
  event,
  placement,
  duration,
}: Timed & { event: FlybyEvent; placement: FlybyPlacement }) {
  const [useFallback, setUseFallback] = useState(
    () => !event.asset || missingAssets.has(event.asset),
  );

  const style: StyleWithVars = {
    top: `${placement.top}%`,
    animationDuration: `${duration}ms`,
    "--evt-scale": String(event.scale ?? 1),
    "--evt-light": rgbVar(event.lightColor ?? DEFAULT_FLYBY_LIGHT),
  };

  return (
    <div className={`evt-flyby evt-flyby-${placement.direction}`} style={style}>
      {useFallback || !event.asset ? (
        <div className="evt-craft" />
      ) : (
        // Plain <img>: optional placeholder art that must fail over to the CSS craft.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="evt-flyby-img"
          src={event.asset}
          alt=""
          draggable={false}
          onError={() => {
            if (event.asset && !missingAssets.has(event.asset)) {
              missingAssets.add(event.asset);
              if (process.env.NODE_ENV !== "production") {
                console.warn(`[orbital-lofi] Event art unavailable, using fallback: ${event.asset}`);
              }
            }
            setUseFallback(true);
          }}
        />
      )}
    </div>
  );
}

export function StreakVisual({
  event,
  placement,
  duration,
}: Timed & { event: StreakEvent; placement: StreakPlacement }) {
  const style: StyleWithVars = {
    left: `${placement.left}%`,
    top: `${placement.top}%`,
    animationDuration: `${duration}ms`,
    "--evt-angle": `${event.angle ?? 24}deg`,
  };

  return <div className="evt-streak" style={style} />;
}

export function PulseVisual({
  event,
  duration,
  reducedMotion,
}: Timed & { event: PulseEvent; reducedMotion: boolean }) {
  const intensity = Math.min(1, Math.max(0, event.intensity)) * (reducedMotion ? 0.5 : 1);
  const style: StyleWithVars = {
    left: `${event.x}%`,
    top: `${event.y}%`,
    animationDuration: `${duration}ms`,
    "--evt-size": `${event.size ?? 20}vmax`,
    "--evt-rgb": rgbVar(event.color),
    "--evt-peak": String(intensity),
  };

  const pattern = reducedMotion ? "calm" : event.pattern;
  return <div className={`evt-pulse evt-pulse-${pattern}`} style={style} />;
}
