"use client";

import { useEffect, useRef } from "react";
import { createBackdropRenderer } from "@/backdrops/createBackdropRenderer";
import type { SceneBackdropId } from "@/worlds/types";

type WorldBackdropProps = {
  backdrop: SceneBackdropId;
  onReady?: () => void;
};

export function WorldBackdrop({ backdrop, onReady }: WorldBackdropProps) {
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
      return createBackdropRenderer(canvas, backdrop, () => {
        onReadyRef.current?.();
      });
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[orbital-lofi] Backdrop "${backdrop}" failed to start`, error);
      }
      onReadyRef.current?.();
    }
  }, [backdrop]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 block h-full w-full"
      aria-hidden
    />
  );
}
