"use client";

import { useEffect, useRef, useState } from "react";
import { useAudioEngine } from "@/audio/useAudioEngine";
import { Hud } from "@/components/Hud";
import { WorldBackdrop } from "@/components/WorldBackdrop";
import { EnvironmentalEffects } from "@/effects/EnvironmentalEffects";
import { EnvironmentalEventLayer } from "@/events/EnvironmentalEventLayer";
import { useHudInteraction } from "@/hud/useHudInteraction";
import { defaultWorldId, getWorldById, worlds } from "@/worlds/worlds";
import type { WorldId } from "@/worlds/types";

const COVER_MS = 550;
const READY_FALLBACK_MS = 650;

export function WorldScene() {
  const [visibleWorldId, setVisibleWorldId] = useState(defaultWorldId);
  const [targetWorldId, setTargetWorldId] = useState(defaultWorldId);
  const [covered, setCovered] = useState(false);
  const visibleWorld = getWorldById(visibleWorldId);
  const {
    isPlaying,
    volume,
    status,
    ambienceVolumes,
    ambienceMuted,
    togglePlayback,
    beginWorldTransition,
    finishWorldTransition,
    setVolume,
    setAmbienceVolume,
    toggleAmbienceMute,
    playEventSound,
    stopEventSound,
  } = useAudioEngine();

  const targetRef = useRef(defaultWorldId);
  const visibleRef = useRef(defaultWorldId);
  const coveredRef = useRef(false);
  const generationRef = useRef(0);
  const timerRef = useRef(0);
  const lastVolumeRef = useRef(volume);

  useEffect(() => {
    targetRef.current = targetWorldId;
  }, [targetWorldId]);

  useEffect(() => {
    visibleRef.current = visibleWorldId;
  }, [visibleWorldId]);

  useEffect(() => {
    coveredRef.current = covered;
  }, [covered]);

  useEffect(() => {
    return () => window.clearTimeout(timerRef.current);
  }, []);

  const clearTimer = () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = 0;
  };

  const revealIfCurrent = (generation: number) => {
    if (generation !== generationRef.current) {
      return;
    }
    if (visibleRef.current !== targetRef.current) {
      return;
    }
    clearTimer();
    coveredRef.current = false;
    setCovered(false);
  };

  const swapToTarget = (generation: number) => {
    if (generation !== generationRef.current) {
      return;
    }
    const next = getWorldById(targetRef.current);
    setVisibleWorldId(next.id);
    visibleRef.current = next.id;
    finishWorldTransition(next);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      revealIfCurrent(generation);
    }, READY_FALLBACK_MS);
  };

  const requestWorld = (worldId: WorldId) => {
    const next = getWorldById(worldId);
    if (next.id === targetRef.current && next.id === visibleRef.current && !coveredRef.current) {
      return;
    }

    targetRef.current = next.id;
    setTargetWorldId(next.id);
    const generation = (generationRef.current += 1);
    beginWorldTransition(next);
    clearTimer();

    if (coveredRef.current) {
      swapToTarget(generation);
      return;
    }

    setCovered(true);
    coveredRef.current = true;
    timerRef.current = window.setTimeout(() => {
      swapToTarget(generation);
    }, COVER_MS);
  };

  useEffect(() => {
    if (volume > 0) {
      lastVolumeRef.current = volume;
    }
  }, [volume]);

  const { hudVisible, idle, hideCursor, toggleHud } = useHudInteraction({
    onTogglePlayback: () => togglePlayback(getWorldById(targetWorldId)),
    onToggleMute: () => {
      if (volume > 0) {
        setVolume(0);
      } else {
        setVolume(lastVolumeRef.current || 0.55);
      }
    },
    onPrevWorld: () => {
      const index = worlds.findIndex((item) => item.id === targetRef.current);
      const next = worlds[(index - 1 + worlds.length) % worlds.length];
      requestWorld(next.id);
    },
    onNextWorld: () => {
      const index = worlds.findIndex((item) => item.id === targetRef.current);
      const next = worlds[(index + 1) % worlds.length];
      requestWorld(next.id);
    },
  });

  return (
    <section
      className={`relative h-dvh w-full overflow-hidden bg-[#050807]${
        hideCursor ? " cursor-none" : ""
      }`}
    >
      <WorldBackdrop
        worldId={visibleWorld.id}
        onReady={() => revealIfCurrent(generationRef.current)}
      />

      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_20%,rgba(2,6,5,0.18)_70%,rgba(2,6,5,0.55)_100%)]" />
      <EnvironmentalEffects key={visibleWorld.id} effects={visibleWorld.effects} />
      <EnvironmentalEventLayer
        key={`events-${visibleWorld.id}`}
        events={visibleWorld.events}
        isPlaying={isPlaying}
        suspended={covered}
        playSound={playEventSound}
        stopSound={stopEventSound}
      />
      <div className={`world-cover${covered ? " world-cover-on" : ""}`} />

      <div
        className={`hud-shell pointer-events-none absolute inset-3 z-10 sm:inset-5${
          hudVisible ? "" : " hud-shell-off"
        }${idle && hudVisible ? " hud-shell-idle" : ""}`}
        aria-hidden={hudVisible ? undefined : true}
      >
        <span className="absolute top-0 left-0 h-5 w-5 border-t border-l border-[#8fd9b8]/40" />
        <span className="absolute top-0 right-0 h-5 w-5 border-t border-r border-[#8fd9b8]/40" />
        <span className="absolute bottom-0 left-0 h-5 w-5 border-b border-l border-[#8fd9b8]/40" />
        <span className="absolute right-0 bottom-0 h-5 w-5 border-b border-r border-[#8fd9b8]/40" />
      </div>

      <Hud
        world={visibleWorld}
        worlds={worlds}
        selectedWorldId={targetWorldId}
        isPlaying={isPlaying}
        status={status}
        volume={volume}
        visible={hudVisible}
        idle={idle}
        onSelectWorld={requestWorld}
        onTogglePlayback={() => togglePlayback(getWorldById(targetWorldId))}
        onVolumeChange={setVolume}
        onToggleHud={toggleHud}
        ambienceVolumes={ambienceVolumes}
        ambienceMuted={ambienceMuted}
        onAmbienceVolumeChange={setAmbienceVolume}
        onAmbienceMuteToggle={toggleAmbienceMute}
      />
    </section>
  );
}
