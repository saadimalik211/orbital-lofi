import type { AmbienceTrack } from "@/worlds/types";

type AmbienceMixerProps = {
  tracks: AmbienceTrack[];
  volumes: Record<string, number>;
  muted: Record<string, boolean>;
  onVolumeChange: (trackId: string, volume: number) => void;
  onToggleMute: (trackId: string, defaultVolume: number) => void;
};

export function AmbienceMixer({
  tracks,
  volumes,
  muted,
  onVolumeChange,
  onToggleMute,
}: AmbienceMixerProps) {
  if (tracks.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-1.5 sm:gap-2" aria-label="Ambience mixer">
      {tracks.map((track) => {
        const volume = volumes[track.id] ?? track.defaultVolume;
        const isMuted = Boolean(muted[track.id]);

        return (
          <div key={track.id} className="flex min-w-0 items-center gap-2 sm:gap-3">
            <span
              className={`w-[6.5rem] shrink-0 truncate font-mono text-[10px] tracking-[0.14em] uppercase sm:w-28 sm:tracking-[0.18em] ${
                isMuted ? "text-[#6f8f80]" : "text-[#8fb8a5]"
              }`}
            >
              {track.name}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => onVolumeChange(track.id, Number(event.target.value))}
              aria-label={`${track.name} volume`}
              className="hud-slider min-w-0 flex-1"
            />
            <button
              type="button"
              aria-pressed={isMuted}
              aria-label={isMuted ? `Unmute ${track.name}` : `Mute ${track.name}`}
              onClick={() => onToggleMute(track.id, track.defaultVolume)}
              className={`hud-mute font-mono text-[9px] tracking-[0.18em] uppercase ${
                isMuted ? "text-[#6f8f80]" : "text-[#d8fff0]"
              }`}
            >
              {isMuted ? "Off" : "On"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
