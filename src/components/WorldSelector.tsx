import type { World, WorldId } from "@/worlds/types";

type WorldSelectorProps = {
  worlds: World[];
  selectedWorldId: WorldId;
  onSelect: (worldId: WorldId) => void;
};

export function WorldSelector({
  worlds,
  selectedWorldId,
  onSelect,
}: WorldSelectorProps) {
  return (
    <nav aria-label="World selector" className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 sm:gap-x-4 sm:gap-y-2">
      {worlds.map((world, index) => {
        const selected = world.id === selectedWorldId;

        return (
          <button
            key={world.id}
            type="button"
            onClick={() => onSelect(world.id)}
            aria-pressed={selected}
            className={`hud-btn px-1 font-mono text-[11px] tracking-[0.18em] uppercase sm:tracking-[0.22em] ${
              selected ? "" : "hud-btn-quiet"
            }`}
          >
            <span className="mr-2 text-[9px] text-[#5e7a6d]">
              {String(index + 1).padStart(2, "0")}
            </span>
            {world.name}
          </button>
        );
      })}
    </nav>
  );
}
