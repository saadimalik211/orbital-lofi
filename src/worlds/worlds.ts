import type { World } from "./types";

export const worlds: World[] = [
  {
    id: "orbital-station",
    name: "Orbital Station",
    year: 2187,
    backdrop: "orbital-station",
    backgroundVideo: "/worlds/orbital-station/background.mp4",
    musicPrompt:
      "slow sci-fi lofi, orbital space station, muted electric piano, soft vinyl crackle, distant hum, 72 bpm, calm, looping instrumental",
  },
  {
    id: "neon-city",
    name: "Neon City",
    year: 2194,
    backdrop: "neon-city",
    backgroundVideo: "/worlds/neon-city/background.mp4",
    musicPrompt:
      "night neon city lofi, rainy cyberpunk streets, warm bass, dusty drums, analog synths, 78 bpm, mellow, looping instrumental",
  },
];

export const defaultWorldId = worlds[0].id;

export function getWorldById(id: string): World | undefined {
  return worlds.find((world) => world.id === id);
}
