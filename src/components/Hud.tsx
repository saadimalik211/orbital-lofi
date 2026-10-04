import { WorldSelector } from "@/components/WorldSelector";
import type { AudioEngineStatus } from "@/audio/useAudioEngine";
import type { World } from "@/worlds/types";

type HudProps = {
  world: World;
  worlds: World[];
  isPlaying: boolean;
  status: AudioEngineStatus;
  volume: number;
  onSelectWorld: (worldId: string) => void;
  onTogglePlayback: () => void;
  onVolumeChange: (volume: number) => void;
};

function statusLabel(status: AudioEngineStatus, isPlaying: boolean) {
  if (status === "loading-model") {
    return "Synth / Loading";
  }
  if (status === "generating") {
    return "Synth / Rendering";
  }
  if (status === "error") {
    return "Synth / Fault";
  }
  if (isPlaying && status === "ready") {
    return "Link / Live";
  }
  if (isPlaying && status === "bed") {
    return "Link / Bed";
  }
  return "Link / Standby";
}

export function Hud({
  world,
  worlds,
  isPlaying,
  status,
  volume,
  onSelectWorld,
  onTogglePlayback,
  onVolumeChange,
}: HudProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-5 pb-16 text-[#c9eadb] sm:p-8 sm:pb-16">
      <header className="pointer-events-auto flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] tracking-[0.42em] text-[#7f9a8e] uppercase">
            Orbital Lofi
          </p>
          <h1 className="mt-3 font-mono text-lg tracking-[0.18em] text-[#e7fff4] uppercase sm:text-2xl">
            {world.name}
          </h1>
          <p className="mt-1 font-mono text-xs tracking-[0.32em] text-[#8fb8a5]">
            YEAR {world.year}
          </p>
        </div>
        <p className="font-mono text-[10px] tracking-[0.28em] text-[#6f8f80] uppercase">
          {statusLabel(status, isPlaying)}
        </p>
      </header>

      <footer className="pointer-events-auto flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-5">
          <button
            type="button"
            onClick={onTogglePlayback}
            className="font-mono text-[11px] tracking-[0.28em] text-[#d8fff0] uppercase"
          >
            {isPlaying ? "Pause" : "Play"}
          </button>

          <label className="flex items-center gap-3 font-mono text-[10px] tracking-[0.24em] text-[#7f9a8e] uppercase">
            Vol
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => onVolumeChange(Number(event.target.value))}
              aria-label="Master volume"
              className="hud-slider w-28 sm:w-36"
            />
          </label>
        </div>

        <WorldSelector
          worlds={worlds}
          selectedWorldId={world.id}
          onSelect={onSelectWorld}
        />
      </footer>
    </div>
  );
}
