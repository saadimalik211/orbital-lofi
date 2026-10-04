import type { World } from "@/worlds/types";

type WorldSelectorProps = {
  worlds: World[];
  selectedWorldId: string;
  onSelect: (worldId: string) => void;
};

export function WorldSelector({
  worlds,
  selectedWorldId,
  onSelect,
}: WorldSelectorProps) {
  return (
    <nav aria-label="World selector" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {worlds.map((world, index) => {
        const selected = world.id === selectedWorldId;

        return (
          <button
            key={world.id}
            type="button"
            onClick={() => onSelect(world.id)}
            aria-pressed={selected}
            className={`font-mono text-[11px] tracking-[0.22em] uppercase transition-colors ${
              selected
                ? "text-[#d8fff0]"
                : "text-[#7f9a8e] hover:text-[#c3e6d4]"
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
