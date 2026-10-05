"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldId } from "@/worlds/types";

const COVER_MS = 550;
const REVEAL_FALLBACK_MS = 650;

/**
 * idle      → nothing in flight
 * covering  → cover is fading in; the swap timer reads the latest target when it fires
 * revealing → screen is black and swapped; waiting for the scene's first frame (or the fallback)
 */
type Phase = "idle" | "covering" | "revealing";

type TransitionOptions = {
  worldIds: readonly WorldId[];
  initialWorldId: WorldId;
  /** A new target was chosen (fires once per change, possibly several times per transition). */
  onBegin: (worldId: WorldId) => void;
  /** The visible world was swapped while the screen is covered. */
  onSwap: (worldId: WorldId) => void;
};

export function useWorldTransition({
  worldIds,
  initialWorldId,
  onBegin,
  onSwap,
}: TransitionOptions) {
  const [visibleWorldId, setVisibleWorldId] = useState(initialWorldId);
  const [targetWorldId, setTargetWorldId] = useState(initialWorldId);
  const [covered, setCovered] = useState(false);

  const phaseRef = useRef<Phase>("idle");
  const targetRef = useRef(initialWorldId);
  const visibleRef = useRef(initialWorldId);
  const timerRef = useRef(0);
  const callbacksRef = useRef({ onBegin, onSwap });

  useEffect(() => {
    callbacksRef.current = { onBegin, onSwap };
  }, [onBegin, onSwap]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const reveal = useCallback(() => {
    if (phaseRef.current !== "revealing") {
      return;
    }
    window.clearTimeout(timerRef.current);
    phaseRef.current = "idle";
    setCovered(false);
  }, []);

  const swap = useCallback(() => {
    window.clearTimeout(timerRef.current);
    const next = targetRef.current;
    const unchanged = next === visibleRef.current;
    phaseRef.current = "revealing";
    visibleRef.current = next;
    setVisibleWorldId(next);
    callbacksRef.current.onSwap(next);
    if (unchanged) {
      reveal();
      return;
    }
    timerRef.current = window.setTimeout(reveal, REVEAL_FALLBACK_MS);
  }, [reveal]);

  const requestWorld = useCallback(
    (worldId: WorldId) => {
      if (worldId === targetRef.current) {
        return;
      }
      targetRef.current = worldId;
      setTargetWorldId(worldId);
      callbacksRef.current.onBegin(worldId);

      if (phaseRef.current === "covering") {
        return;
      }
      if (phaseRef.current === "revealing") {
        swap();
        return;
      }
      phaseRef.current = "covering";
      setCovered(true);
      timerRef.current = window.setTimeout(swap, COVER_MS);
    },
    [swap],
  );

  const stepWorld = useCallback(
    (delta: number) => {
      const index = Math.max(0, worldIds.indexOf(targetRef.current));
      const next = worldIds[(index + delta + worldIds.length) % worldIds.length];
      if (next) {
        requestWorld(next);
      }
    },
    [requestWorld, worldIds],
  );

  /** Call when the visible scene has drawn its first frame. */
  const sceneReady = useCallback(() => {
    if (visibleRef.current === targetRef.current) {
      reveal();
    }
  }, [reveal]);

  return {
    visibleWorldId,
    targetWorldId,
    covered,
    requestWorld,
    stepWorld,
    sceneReady,
  };
}
