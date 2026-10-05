"use client";

import { useEffect, useRef } from "react";
import { createBackdropRenderer } from "@/backdrops/createBackdropRenderer";
import type { WorldId } from "@/worlds/types";

type WorldBackdropProps = {
  worldId: WorldId;
  onReady?: () => void;
};

export function WorldBackdrop({ worldId, onReady }: WorldBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    try {
      return createBackdropRenderer(canvas, worldId, () => {
        onReadyRef.current?.();
      });
    } catch {
      onReadyRef.current?.();
      return;
    }
  }, [worldId]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 block h-full w-full"
      aria-hidden
    />
  );
}
