"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/effects/useReducedMotion";
import {
  createEventScheduler,
  eventDuration,
  randomBetween,
} from "@/events/eventScheduler";
import {
  FlybyVisual,
  PulseVisual,
  StreakVisual,
  type FlybyPlacement,
  type StreakPlacement,
} from "@/events/EventVisuals";
import type { WorldEvent } from "@/worlds/types";

type EnvironmentalEventLayerProps = {
  events: WorldEvent[];
  isPlaying: boolean;
  suspended: boolean;
  playSound: (src: string, volume?: number) => Promise<boolean>;
  stopSound: () => void;
};

type ActiveVisual = {
  key: number;
  event: WorldEvent;
  flyby?: FlybyPlacement;
  streak?: StreakPlacement;
};

type DevHandle = {
  list: () => string[];
  trigger: (idOrType?: string) => string | null;
};

declare global {
  interface Window {
    orbitalEvents?: DevHandle;
  }
}

function place(event: WorldEvent): Pick<ActiveVisual, "flyby" | "streak"> {
  if (event.type === "flyby") {
    const [min, max] = event.top ?? [14, 36];
    const direction =
      event.direction === "ltr" || event.direction === "rtl"
        ? event.direction
        : Math.random() < 0.5
          ? "ltr"
          : "rtl";
    return { flyby: { top: randomBetween(min, max), direction } };
  }
  if (event.type === "streak") {
    return { streak: { left: randomBetween(8, 62), top: randomBetween(4, 30) } };
  }
  return {};
}

export function EnvironmentalEventLayer({
  events,
  isPlaying,
  suspended,
  playSound,
  stopSound,
}: EnvironmentalEventLayerProps) {
  const reducedMotion = useReducedMotion();
  const [active, setActive] = useState<ActiveVisual | null>(null);
  const gateRef = useRef({ isPlaying, suspended, reducedMotion });

  useEffect(() => {
    gateRef.current = { isPlaying, suspended, reducedMotion };
  }, [isPlaying, suspended, reducedMotion]);

  useEffect(() => {
    let key = 0;

    const scheduler = createEventScheduler({
      events,
      canRun: (event) => {
        const gate = gateRef.current;
        if (gate.suspended || document.hidden) {
          return false;
        }
        if (event.type === "sound") {
          return gate.isPlaying;
        }
        if (gate.reducedMotion && (event.type === "flyby" || event.type === "streak")) {
          return false;
        }
        return true;
      },
      onStart: (event) => {
        if (event.sound && gateRef.current.isPlaying) {
          void playSound(event.sound.src, event.sound.volume);
        }
        if (event.type === "sound") {
          return;
        }
        key += 1;
        setActive({ key, event, ...place(event) });
      },
      onEnd: (event) => {
        if (event.type !== "sound") {
          setActive(null);
        }
      },
    });

    const dev: DevHandle | null =
      process.env.NODE_ENV === "production"
        ? null
        : {
            list: () => events.map((event) => `${event.id} (${event.type})`),
            trigger: (idOrType) => scheduler.trigger(idOrType),
          };
    if (dev) {
      window.orbitalEvents = dev;
    }

    return () => {
      scheduler.dispose();
      stopSound();
      if (dev && window.orbitalEvents === dev) {
        delete window.orbitalEvents;
      }
    };
  }, [events, playSound, stopSound]);

  if (!active) {
    return <div className="evt-layer" aria-hidden />;
  }

  const duration = eventDuration(active.event);
  const { event } = active;

  return (
    <div className="evt-layer" aria-hidden>
      {event.type === "flyby" && active.flyby ? (
        <FlybyVisual key={active.key} event={event} placement={active.flyby} duration={duration} />
      ) : null}
      {event.type === "streak" && active.streak ? (
        <StreakVisual key={active.key} event={event} placement={active.streak} duration={duration} />
      ) : null}
      {event.type === "pulse" ? (
        <PulseVisual
          key={active.key}
          event={event}
          duration={duration}
          reducedMotion={reducedMotion}
        />
      ) : null}
    </div>
  );
}
