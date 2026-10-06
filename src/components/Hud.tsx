import { AmbienceMixer } from "@/components/AmbienceMixer";
import { WorldSelector } from "@/components/WorldSelector";
import type { AmbiencePrefs } from "@/audio/ambiencePrefs";
import type { AudioEngineStatus } from "@/audio/useAudioEngine";
import type { World, WorldId } from "@/worlds/types";

type HudProps = {
  world: World;
  worlds: World[];
  selectedWorldId: WorldId;
  isPlaying: boolean;
  status: AudioEngineStatus;
  volume: number;
  visible: boolean;
  idle: boolean;
  onSelectWorld: (worldId: WorldId) => void;
  onTogglePlayback: () => void;
  onNextComposition: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleHud: () => void;
  ambiencePrefs: AmbiencePrefs;
  onAmbienceVolumeChange: (trackId: string, volume: number) => void;
  onAmbienceMuteToggle: (trackId: string) => void;
};

function statusLabel(status: AudioEngineStatus, isPlaying: boolean) {
  if (status === "error") {
    return "Synth / Fault";
  }
  return isPlaying && status === "live" ? "Link / Live" : "Link / Standby";
}

export function Hud({
  world,
  worlds,
  selectedWorldId,
  isPlaying,
  status,
  volume,
  visible,
  idle,
  onSelectWorld,
  onTogglePlayback,
  onNextComposition,
  onVolumeChange,
  onToggleHud,
  ambiencePrefs,
  onAmbienceVolumeChange,
  onAmbienceMuteToggle,
}: HudProps) {
  const stateClass = `${visible ? "" : " hud-shell-off"}${idle && visible ? " hud-shell-idle" : ""}`;
  const hidden = visible ? undefined : true;

  return (
    <>
      <div
        className={`hud-shell pointer-events-none absolute inset-3 z-10 sm:inset-5${stateClass}`}
        aria-hidden
      >
        <span className="absolute top-0 left-0 h-5 w-5 border-t border-l border-[#8fd9b8]/40" />
        <span className="absolute top-0 right-0 h-5 w-5 border-t border-r border-[#8fd9b8]/40" />
        <span className="absolute bottom-0 left-0 h-5 w-5 border-b border-l border-[#8fd9b8]/40" />
        <span className="absolute right-0 bottom-0 h-5 w-5 border-b border-r border-[#8fd9b8]/40" />
      </div>

      <div
        className={`hud-shell pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4 pb-[max(4.5rem,env(safe-area-inset-bottom))] text-[#c9eadb] sm:p-8 sm:pb-16${stateClass}`}
        aria-hidden={hidden}
      >
        <header className="pointer-events-auto flex items-start justify-between gap-4 pr-16 sm:pr-20">
          <div className="min-w-0">
            <p className="font-mono text-[10px] tracking-[0.42em] text-[#7f9a8e] uppercase">
              Orbital Lofi
            </p>
            <h1 className="mt-2 font-mono text-base tracking-[0.16em] text-[#e7fff4] uppercase sm:mt-3 sm:text-2xl sm:tracking-[0.18em]">
              {world.name}
            </h1>
            <p className="mt-1 font-mono text-[11px] tracking-[0.28em] text-[#8fb8a5] sm:text-xs sm:tracking-[0.32em]">
              YEAR {world.year}
            </p>
          </div>
          <p className="shrink-0 pt-1 font-mono text-[10px] tracking-[0.24em] text-[#6f8f80] uppercase sm:tracking-[0.28em]">
            {statusLabel(status, isPlaying)}
          </p>
        </header>

        <footer className="pointer-events-auto flex max-w-full flex-col gap-4 sm:gap-5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <button
              type="button"
              onClick={onTogglePlayback}
              className={`hud-btn px-1 font-mono text-[11px] tracking-[0.28em] uppercase ${
                isPlaying ? "" : "hud-btn-quiet"
              }`}
            >
              {isPlaying ? "Pause" : "Play"}
            </button>

            <button
              type="button"
              onClick={onNextComposition}
              aria-label="Next track"
              title="Next track"
              className="hud-btn hud-btn-quiet px-1 font-mono text-[11px] tracking-[0.28em] uppercase"
            >
              Next <span aria-hidden>&gt;|</span>
            </button>

            <label
              className={`flex min-h-11 items-center gap-3 font-mono text-[10px] tracking-[0.24em] uppercase ${
                volume === 0 ? "text-[#6f8f80]" : "text-[#7f9a8e]"
              }`}
            >
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

          <AmbienceMixer
            tracks={world.ambience}
            prefs={ambiencePrefs}
            onVolumeChange={onAmbienceVolumeChange}
            onToggleMute={onAmbienceMuteToggle}
          />

          <WorldSelector
            worlds={worlds}
            selectedWorldId={selectedWorldId}
            onSelect={onSelectWorld}
          />
        </footer>
      </div>

      <button
        type="button"
        onClick={onToggleHud}
        aria-pressed={visible}
        aria-label={visible ? "Hide interface" : "Show interface"}
        className={`hud-reveal pointer-events-auto absolute top-4 right-4 z-20 min-h-11 px-1 font-mono text-[10px] tracking-[0.32em] text-[#9ecbb6] uppercase sm:top-8 sm:right-8 ${
          idle ? "hud-reveal-idle" : ""
        }`}
      >
        HUD
      </button>
    </>
  );
}
