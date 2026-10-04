"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readClip, writeClip } from "@/audio/clipCache";
import {
  pcmToAudioBuffer,
  startLoopingBuffer,
  type LoopHandle,
} from "@/audio/loopBuffer";
import { generateMusicClip, warmupMusicgen } from "@/audio/musicgenClient";
import { MUSIC_STYLES, type MusicStyle } from "@/audio/musicStyles";
import {
  createProceduralEngine,
  type ProceduralEngine,
} from "@/audio/proceduralEngine";

export type AudioEngineStatus =
  | "idle"
  | "loading-model"
  | "generating"
  | "bed"
  | "ready"
  | "error";

function styleForWorld(worldId: string): MusicStyle {
  return (
    MUSIC_STYLES[worldId as keyof typeof MUSIC_STYLES] ??
    MUSIC_STYLES["orbital-station"]
  );
}

function fadeTo(gain: GainNode, value: number, seconds = 0.85) {
  const now = gain.context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(value, now + seconds);
}

export function useAudioEngine() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolumeState] = useState(0.55);
  const [status, setStatus] = useState<AudioEngineStatus>("idle");

  const contextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const bedGainRef = useRef<GainNode | null>(null);
  const clipGainRef = useRef<GainNode | null>(null);
  const engineRef = useRef<ProceduralEngine | null>(null);
  const loopRef = useRef<LoopHandle | null>(null);
  const bootRef = useRef<Promise<ProceduralEngine | null> | null>(null);
  const isPlayingRef = useRef(false);
  const volumeRef = useRef(volume);
  const worldRef = useRef({ id: "orbital-station", prompt: "" });
  const requestRef = useRef(0);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  const ensureGraph = useCallback(async () => {
    if (!bootRef.current) {
      bootRef.current = (async () => {
        const context = new AudioContext();
        const masterGain = context.createGain();
        const bedGain = context.createGain();
        const clipGain = context.createGain();
        masterGain.gain.value = volumeRef.current;
        bedGain.gain.value = 1;
        clipGain.gain.value = 0;
        bedGain.connect(masterGain);
        clipGain.connect(masterGain);
        masterGain.connect(context.destination);
        contextRef.current = context;
        masterGainRef.current = masterGain;
        bedGainRef.current = bedGain;
        clipGainRef.current = clipGain;
        const engine = await createProceduralEngine(context, bedGain);
        engineRef.current = engine;
        return engine;
      })().catch((error: unknown) => {
        bootRef.current = null;
        throw error;
      });
    }

    const engine = await bootRef.current;
    if (contextRef.current?.state === "suspended") {
      await contextRef.current.resume();
    }
    return engine;
  }, []);

  const stopClip = useCallback((fadeSeconds = 0.4) => {
    loopRef.current?.stop(fadeSeconds);
    loopRef.current = null;
  }, []);

  const playClip = useCallback((clip: { samples: Float32Array; sampleRate: number }) => {
    const context = contextRef.current;
    const clipGain = clipGainRef.current;
    const bedGain = bedGainRef.current;
    if (!context || !clipGain || !bedGain) {
      return;
    }

    stopClip(0.2);
    const buffer = pcmToAudioBuffer(context, clip.samples, clip.sampleRate);
    fadeTo(bedGain, 0, 0.9);
    fadeTo(clipGain, 1, 0.9);
    loopRef.current = startLoopingBuffer(context, clipGain, buffer);
    engineRef.current?.stop();
    setStatus("ready");
  }, [stopClip]);

  const requestNeuralClip = useCallback(
    async (worldId: string, prompt: string) => {
      const token = (requestRef.current += 1);
      const cached = await readClip(worldId);
      if (token !== requestRef.current || !isPlayingRef.current) {
        return;
      }
      if (cached) {
        playClip(cached);
        return;
      }

      try {
        const clip = await generateMusicClip(prompt, (nextStatus) => {
          if (worldRef.current.id === worldId && isPlayingRef.current) {
            setStatus(nextStatus);
          }
        });
        await writeClip(worldId, clip);
        if (token !== requestRef.current || !isPlayingRef.current) {
          return;
        }
        if (worldRef.current.id !== worldId) {
          return;
        }
        playClip(clip);
      } catch {
        if (token === requestRef.current && isPlayingRef.current) {
          setStatus("bed");
        }
      }
    },
    [playClip],
  );

  const startBed = useCallback(
    (worldId: string) => {
      const bedGain = bedGainRef.current;
      const clipGain = clipGainRef.current;
      if (bedGain && clipGain) {
        fadeTo(clipGain, 0, 0.4);
        fadeTo(bedGain, 1, 0.4);
      }
      stopClip(0.4);
      engineRef.current?.start(styleForWorld(worldId));
      setStatus("bed");
    },
    [stopClip],
  );

  const togglePlayback = useCallback(
    async (worldId: string, prompt: string) => {
      worldRef.current = { id: worldId, prompt };

      if (isPlayingRef.current) {
        requestRef.current += 1;
        isPlayingRef.current = false;
        setIsPlaying(false);
        engineRef.current?.stop();
        stopClip(0.25);
        setStatus("idle");
        return;
      }

      try {
        const engine = await ensureGraph();
        if (!engine) {
          throw new Error("Audio engine missing");
        }
        isPlayingRef.current = true;
        setIsPlaying(true);
        startBed(worldId);
        void requestNeuralClip(worldId, prompt);
      } catch {
        isPlayingRef.current = false;
        setIsPlaying(false);
        setStatus("error");
      }
    },
    [ensureGraph, requestNeuralClip, startBed, stopClip],
  );

  const changeWorld = useCallback(
    (worldId: string, prompt: string) => {
      worldRef.current = { id: worldId, prompt };
      if (!isPlayingRef.current) {
        return;
      }
      startBed(worldId);
      void requestNeuralClip(worldId, prompt);
    },
    [requestNeuralClip, startBed],
  );

  const setVolume = useCallback((nextVolume: number) => {
    const clamped = Math.min(1, Math.max(0, nextVolume));
    setVolumeState(clamped);
    const gain = masterGainRef.current;
    if (gain) {
      gain.gain.setTargetAtTime(clamped, gain.context.currentTime, 0.02);
    }
  }, []);

  useEffect(() => {
    const warm = () => {
      void warmupMusicgen((nextStatus) => {
        if (!isPlayingRef.current) {
          setStatus(nextStatus);
        }
      }).then(() => {
        if (!isPlayingRef.current) {
          setStatus("idle");
        }
      }).catch(() => {});
    };

    const idle = window.requestIdleCallback?.(warm, { timeout: 1200 });
    const fallback =
      typeof idle === "number" ? 0 : window.setTimeout(warm, 400);
    return () => {
      if (typeof idle === "number") {
        window.cancelIdleCallback?.(idle);
      }
      if (fallback) {
        window.clearTimeout(fallback);
      }
      requestRef.current += 1;
      engineRef.current?.stop();
      loopRef.current?.stop(0.01);
    };
  }, []);

  return {
    isPlaying,
    volume,
    status,
    togglePlayback,
    changeWorld,
    setVolume,
  };
}
