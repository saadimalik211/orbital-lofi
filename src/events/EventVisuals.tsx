"use client";

import { useState, type CSSProperties } from "react";
import type { FlybyEvent, PulseEvent, StreakEvent } from "@/worlds/types";

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

  const style = {
    top: `${placement.top}%`,
    animationDuration: `${duration}ms`,
    "--evt-scale": String(event.scale ?? 1),
    "--evt-light": event.lightColor ?? "200, 230, 255",
  } as CSSProperties;

  return (
    <div className={`evt-flyby evt-flyby-${placement.direction}`} style={style}>
      {useFallback ? (
        <div className="evt-craft" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="evt-flyby-img"
          src={event.asset}
          alt=""
          draggable={false}
          onError={() => {
            if (event.asset) {
              missingAssets.add(event.asset);
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
  const style = {
    left: `${placement.left}%`,
    top: `${placement.top}%`,
    animationDuration: `${duration}ms`,
    "--evt-angle": `${event.angle ?? 24}deg`,
  } as CSSProperties;

  return <div className="evt-streak" style={style} />;
}

export function PulseVisual({
  event,
  duration,
  reducedMotion,
}: Timed & { event: PulseEvent; reducedMotion: boolean }) {
  const intensity = Math.min(1, Math.max(0, event.intensity)) * (reducedMotion ? 0.5 : 1);
  const style = {
    left: `${event.x}%`,
    top: `${event.y}%`,
    animationDuration: `${duration}ms`,
    "--evt-size": `${event.size ?? 20}vmax`,
    "--evt-rgb": event.color,
    "--evt-peak": String(intensity),
  } as CSSProperties;

  const pattern = reducedMotion ? "calm" : event.pattern;
  return <div className={`evt-pulse evt-pulse-${pattern}`} style={style} />;
}
