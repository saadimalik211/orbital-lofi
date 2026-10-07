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
    if (!music.prompt.trim()) {
      problems.push(`${at("music.prompt")} must be non-empty`);
    }
    if (music.tempo[0] > music.tempo[1]) {
      problems.push(`${at("music.tempo")} min > max`);
    }
    for (const [group, values] of [
      ["", { ...music.density, ...music.space, tape: music.tape ?? 0 }],
      ["sound.", music.sound],
    ] as const) {
      for (const [name, value] of Object.entries(values)) {
        if (!inUnitRange(value)) {
          problems.push(`${at(`music.${group}${name}`)} must be 0–1`);
        }
      }
    }
    const { reverb } = music;
    if (!inUnitRange(reverb.amount) || !inUnitRange(reverb.damping)) {
      problems.push(`${at("music.reverb")} amount and damping must be 0–1`);
    }
    if (reverb.decay < 0.4 || reverb.decay > 4.5) {
      problems.push(`${at("music.reverb.decay")} must be 0.4–4.5 seconds`);
    }
    const preDelay = reverb.preDelay ?? 0;
    if (preDelay < 0 || preDelay > 0.08) {
      problems.push(`${at("music.reverb.preDelay")} must be 0–0.08 seconds`);
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
    const checkForm = (sections: readonly { bars: number; drums: number; bass: number; melody: number }[], label: string) => {
      sections.forEach((section, i) => {
        const path = at(`${label}[${i}]`);
        if (section.bars < 1 || section.bars % pass !== 0) {
          problems.push(`${path} bars should be a multiple of ${pass} (one progression pass)`);
        }
        if (![section.drums, section.bass, section.melody].every(inUnitRange)) {
          problems.push(`${path} layer levels must be 0–1`);
        }
      });
    };
    checkForm(music.form, "music.form");
    music.forms?.forEach((form, i) => checkForm(form, `music.forms[${i}]`));

    const aiIds = new Set<string>();
    for (const track of world.aiMusic ?? []) {
      const path = `aiMusic.${track.id || "(missing id)"}`;
      if (!track.id.trim()) {
        problems.push(`${at("aiMusic")} track id must be non-empty`);
      } else if (aiIds.has(track.id)) {
        problems.push(`${at("aiMusic")} duplicate track id "${track.id}"`);
      }
      aiIds.add(track.id);
      checkSrc(path, track.src);
      if (track.src && !track.src.includes("/music/ai/")) {
        problems.push(`${at(path)} should live under ${folder}music/ai/`);
      }
      const bpm = track.metadata?.bpm;
      if (bpm !== undefined && (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)) {
        problems.push(`${at(`${path}.metadata.bpm`)} must be 20–300`);
      }
      if (track.metadata?.key !== undefined && !track.metadata.key.trim()) {
        problems.push(`${at(`${path}.metadata.key`)} must be non-empty when set`);
      }
      if (track.metadata?.mode !== undefined && !track.metadata.mode.trim()) {
        problems.push(`${at(`${path}.metadata.mode`)} must be non-empty when set`);
      }
    }

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
    const fogColor = world.effects.fog?.color;
    if (fogColor && !fogColor.every((channel) => channel >= 0 && channel <= 255)) {
      problems.push(`${at("effects.fog.color")} channels must be 0–255`);
    }
    const particleColor = world.effects.particles?.color;
    if (particleColor && !particleColor.every((channel) => channel >= 0 && channel <= 255)) {
      problems.push(`${at("effects.particles.color")} channels must be 0–255`);
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
