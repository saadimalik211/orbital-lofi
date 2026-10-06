"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { createBackdropRenderer } from "@/backdrops/createBackdropRenderer";
import { publicPath } from "@/lib/publicPath";
import type { SceneBackdropId, SceneConfig } from "@/worlds/types";

type WorldBackdropProps = {
  scene: SceneConfig;
  /** Fires once the scene has something to show (or has failed), so the transition cover can lift. */
  onReady?: () => void;
};

const MEDIA_CLASS = "pointer-events-none absolute inset-0 h-full w-full object-cover select-none";

function warnFailed(what: string, error?: unknown) {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[orbital-lofi] Scene unavailable: ${what}`, error ?? "");
  }
}

export function WorldBackdrop({ scene, onReady }: WorldBackdropProps) {
  const ready = () => onReady?.();
  const failed = (what: string) => () => {
    warnFailed(what);
    onReady?.();
  };

  if (scene.type === "image") {
    return (
      <Image
        src={publicPath(scene.src)}
        alt=""
        aria-hidden
        fill
        sizes="100vw"
        loading="eager"
        fetchPriority="high"
        draggable={false}
        className={MEDIA_CLASS}
        onLoad={ready}
        onError={failed(scene.src)}
      />
    );
  }

  if (scene.type === "video") {
    return (
      <video
        src={publicPath(scene.src)}
        poster={scene.poster ? publicPath(scene.poster) : undefined}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden
        className={MEDIA_CLASS}
        onLoadedData={ready}
        onError={failed(scene.src)}
      />
    );
  }

  return <ShaderBackdrop backdrop={scene.backdrop} onReady={onReady} />;
}

function ShaderBackdrop({
  backdrop,
  onReady,
}: {
  backdrop: SceneBackdropId;
  onReady?: () => void;
}) {
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
      warnFailed(`shader "${backdrop}"`, error);
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
