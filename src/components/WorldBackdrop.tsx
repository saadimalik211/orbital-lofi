"use client";

import { useEffect, useRef } from "react";
import { createBackdropRenderer } from "@/backdrops/createBackdropRenderer";
import type { WorldBackdropId } from "@/worlds/types";

type WorldBackdropProps = {
  backdrop: WorldBackdropId;
};

export function WorldBackdrop({ backdrop }: WorldBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    try {
      return createBackdropRenderer(canvas, backdrop);
    } catch {
      return;
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
