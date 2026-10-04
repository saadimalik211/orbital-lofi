"use client";

import { useState } from "react";
import { useAudioEngine } from "@/audio/useAudioEngine";
import { Hud } from "@/components/Hud";
import { WorldBackdrop } from "@/components/WorldBackdrop";
import type { World } from "@/worlds/types";
import { getWorldById } from "@/worlds/worlds";

type WorldSceneProps = {
  worlds: World[];
  initialWorldId: string;
};

export function WorldScene({ worlds, initialWorldId }: WorldSceneProps) {
  const [selectedWorldId, setSelectedWorldId] = useState(initialWorldId);
  const world = getWorldById(selectedWorldId) ?? worlds[0];

  const { isPlaying, volume, status, togglePlayback, changeWorld, setVolume } =
    useAudioEngine();

  const handleSelectWorld = (worldId: string) => {
    setSelectedWorldId(worldId);
    const next = getWorldById(worldId) ?? worlds[0];
    changeWorld(next.id, next.musicPrompt);
  };

  return (
    <section className="relative h-dvh w-full overflow-hidden bg-[#050807]">
      <WorldBackdrop backdrop={world.backdrop} />

      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_20%,rgba(2,6,5,0.18)_70%,rgba(2,6,5,0.55)_100%)]" />

      <div className="pointer-events-none absolute inset-3 sm:inset-5">
        <span className="absolute top-0 left-0 h-5 w-5 border-t border-l border-[#8fd9b8]/40" />
        <span className="absolute top-0 right-0 h-5 w-5 border-t border-r border-[#8fd9b8]/40" />
        <span className="absolute bottom-0 left-0 h-5 w-5 border-b border-l border-[#8fd9b8]/40" />
        <span className="absolute right-0 bottom-0 h-5 w-5 border-b border-r border-[#8fd9b8]/40" />
      </div>

      <Hud
        world={world}
        worlds={worlds}
        isPlaying={isPlaying}
        status={status}
        volume={volume}
        onSelectWorld={handleSelectWorld}
        onTogglePlayback={() => togglePlayback(world.id, world.musicPrompt)}
        onVolumeChange={setVolume}
      />
    </section>
  );
}
