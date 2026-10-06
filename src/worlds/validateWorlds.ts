import type { World } from "./types";

const inUnitRange = (value: number) => value >= 0 && value <= 1;

/** Dev-only sanity check for hand-written world config. Warns; never throws. */
export function validateWorlds(worlds: readonly World[]) {
  const problems: string[] = [];
  const seenWorlds = new Set<string>();

  for (const world of worlds) {
    const at = (path: string) => `${world.id}.${path}`;
    const folder = `/worlds/${world.id}/`;
    const checkSrc = (path: string, src: string | undefined) => {
      if (src && !src.startsWith(folder)) {
        problems.push(`${at(path)} should live under ${folder}`);
      }
    };

    if (seenWorlds.has(world.id)) {
      problems.push(`duplicate world id "${world.id}"`);
    }
    seenWorlds.add(world.id);

    if (world.scene.type !== "shader") {
      checkSrc("scene", world.scene.src);
    }

    const { music } = world;
    if (music.tempo[0] > music.tempo[1]) {
      problems.push(`${at("music.tempo")} min > max`);
    }
    for (const [name, value] of Object.entries({ ...music.density, ...music.space, tape: music.tape ?? 0 })) {
      if (!inUnitRange(value)) {
        problems.push(`${at(`music.${name}`)} must be 0–1`);
      }
    }
    const groove = music.groove ?? {};
    for (const [name, value, max] of [
      ["swing", groove.swing, 0.3],
      ["timingHumanization", groove.timingHumanization, 0.03],
      ["velocityHumanization", groove.velocityHumanization, 0.3],
    ] as const) {
      if (value !== undefined && (value < 0 || value > max)) {
        problems.push(`${at(`music.groove.${name}`)} must be 0–${max}`);
      }
    }
    const pass = 4 * music.chords.barsPerChord;
    music.form.forEach((section, i) => {
      const path = at(`music.form[${i}]`);
      if (section.bars < 1 || section.bars % pass !== 0) {
        problems.push(`${path} bars should be a multiple of ${pass} (one progression pass)`);
      }
      if (![section.drums, section.bass, section.melody].every(inUnitRange)) {
        problems.push(`${path} layer levels must be 0–1`);
      }
    });

    const trackIds = new Set<string>();
    for (const track of world.ambience) {
      if (trackIds.has(track.id)) {
        problems.push(`${at("ambience")} duplicate track id "${track.id}"`);
      }
      trackIds.add(track.id);
      if (!inUnitRange(track.defaultVolume)) {
        problems.push(`${at(`ambience.${track.id}`)} defaultVolume must be 0–1`);
      }
      checkSrc(`ambience.${track.id}`, track.src);
    }

    for (const [name, effect] of Object.entries(world.effects)) {
      if (effect && !inUnitRange(effect.intensity)) {
        problems.push(`${at(`effects.${name}`)} intensity must be 0–1`);
      }
    }

    const eventIds = new Set<string>();
    for (const event of world.events) {
      const path = `events.${event.id}`;
      if (eventIds.has(event.id)) {
        problems.push(`${at("events")} duplicate event id "${event.id}"`);
      }
      eventIds.add(event.id);
      if (event.weight <= 0) {
        problems.push(`${at(path)} weight must be > 0`);
      }
      if (event.minDelay > event.maxDelay) {
        problems.push(`${at(path)} minDelay > maxDelay`);
      }
      checkSrc(`${path}.sound`, event.sound?.src);
      if (event.type === "flyby") {
        checkSrc(`${path}.asset`, event.asset);
      }
    }
  }

  if (problems.length > 0) {
    console.warn(`[orbital-lofi] World config issues:\n- ${problems.join("\n- ")}`);
  }
}
