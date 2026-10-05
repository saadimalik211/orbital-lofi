import type { World, WorldId } from "./types";
import { validateWorlds } from "./validateWorlds";

/**
 * Assets live under `public/worlds/<world-id>/{scene,music,ambience,events}/`.
 * Any referenced file may be missing: that layer stays silent / falls back, nothing else breaks.
 */
export const worlds: World[] = [
  {
    id: "orbital-station",
    name: "Orbital Station",
    year: 2187,
    scene: { type: "image", src: "/worlds/orbital-station/scene/orbital-station.png" },
    music: [
      {
        id: "orbital-drift",
        title: "Drift",
        generate: {
          prompt:
            "restrained ambient electronic, deep space station drifting in orbit, warm analog pads, soft sub pulse, sparse electric piano, gentle tape hiss, 68 bpm, calm, spacious, looping instrumental",
          bed: { seed: 2187, bpm: 68, rootMidi: 57, swing: 0.54, brightness: 0.3, texture: 0.3 },
        },
      },
      {
        id: "orbital-observation",
        title: "Observation Deck",
        generate: {
          prompt:
            "minimal ambient electronic, quiet space station observation deck, glassy slow arpeggios, soft analog pads, distant chimes, 64 bpm, serene, looping instrumental",
          bed: { seed: 2188, bpm: 64, rootMidi: 55, swing: 0.52, brightness: 0.38, texture: 0.25 },
        },
      },
    ],
    ambience: [
      {
        id: "engine",
        name: "Engine Hum",
        src: "/worlds/orbital-station/ambience/engine.wav",
        defaultVolume: 0.34,
      },
      {
        id: "vent",
        name: "Ventilation",
        src: "/worlds/orbital-station/ambience/vent.wav",
        defaultVolume: 0.24,
      },
      {
        id: "radio",
        name: "Radio Chatter",
        src: "/worlds/orbital-station/ambience/radio.wav",
        defaultVolume: 0.12,
      },
    ],
    effects: {
      stars: { intensity: 0.22 },
      fog: { intensity: 0.1 },
      flicker: { intensity: 0.05, style: "screen" },
    },
    events: [
      {
        id: "shuttle-pass",
        type: "flyby",
        asset: "/worlds/orbital-station/events/shuttle.png",
        direction: "either",
        top: [14, 34],
        scale: 0.9,
        lightColor: [150, 220, 255],
        weight: 3,
        minDelay: 30_000,
        maxDelay: 80_000,
        cooldown: 60_000,
        duration: 12_000,
      },
      {
        id: "docking-beacon",
        type: "pulse",
        pattern: "beacon",
        color: [255, 120, 90],
        x: 78,
        y: 22,
        size: 18,
        intensity: 0.45,
        weight: 3,
        minDelay: 20_000,
        maxDelay: 50_000,
        duration: 2_400,
      },
      {
        id: "docking-announcement",
        type: "sound",
        sound: { src: "/worlds/orbital-station/events/docking-announcement.wav", volume: 0.42 },
        weight: 2,
        minDelay: 70_000,
        maxDelay: 160_000,
        cooldown: 150_000,
        duration: 5_000,
      },
      {
        id: "meteor",
        type: "streak",
        angle: 24,
        weight: 1,
        minDelay: 120_000,
        maxDelay: 300_000,
        cooldown: 240_000,
        duration: 1_400,
      },
    ],
  },
  {
    id: "neon-city",
    name: "Neon City",
    year: 2194,
    scene: { type: "image", src: "/worlds/neon-city/scene/neon-city.png" },
    music: [
      {
        id: "neon-wet-pavement",
        title: "Wet Pavement",
        generate: {
          prompt:
            "dark rainy cyberpunk lofi, neon city at night, muffled dusty drums, deep warm bass, moody analog synth chords, 80 bpm, melancholic, looping instrumental",
          bed: { seed: 2194, bpm: 80, rootMidi: 50, swing: 0.6, brightness: 0.28, texture: 0.65 },
        },
      },
      {
        id: "neon-last-train",
        title: "Last Train",
        generate: {
          prompt:
            "late night cyberpunk lofi, empty neon train platform, warm rhodes, deep sub bass, lazy brushed drums, 76 bpm, moody, looping instrumental",
          bed: { seed: 2196, bpm: 76, rootMidi: 48, swing: 0.58, brightness: 0.24, texture: 0.7 },
        },
      },
    ],
    ambience: [
      {
        id: "rain",
        name: "Rain",
        src: "/worlds/neon-city/ambience/rain.wav",
        defaultVolume: 0.46,
      },
      {
        id: "traffic",
        name: "Distant Traffic",
        src: "/worlds/neon-city/ambience/traffic.wav",
        defaultVolume: 0.24,
      },
      {
        id: "crowd",
        name: "City Hum",
        src: "/worlds/neon-city/ambience/crowd.wav",
        defaultVolume: 0.18,
      },
    ],
    effects: {
      rain: { intensity: 0.78 },
      fog: { intensity: 0.24 },
      flicker: { intensity: 0.12, style: "neon" },
    },
    events: [
      {
        id: "hovercar-pass",
        type: "flyby",
        asset: "/worlds/neon-city/events/hovercar.png",
        direction: "either",
        top: [18, 42],
        scale: 0.7,
        lightColor: [255, 90, 190],
        weight: 4,
        minDelay: 18_000,
        maxDelay: 50_000,
        cooldown: 25_000,
        duration: 8_000,
      },
      {
        id: "sign-glitch",
        type: "pulse",
        pattern: "glitch",
        color: [80, 220, 255],
        x: 24,
        y: 30,
        size: 26,
        intensity: 0.42,
        weight: 3,
        minDelay: 25_000,
        maxDelay: 60_000,
        duration: 1_800,
      },
      {
        id: "distant-siren",
        type: "sound",
        sound: { src: "/worlds/neon-city/events/siren.wav", volume: 0.3 },
        weight: 1,
        minDelay: 90_000,
        maxDelay: 240_000,
        cooldown: 200_000,
        duration: 7_000,
      },
      {
        id: "distant-lightning",
        type: "pulse",
        pattern: "flash",
        color: [200, 215, 255],
        x: 62,
        y: 8,
        size: 90,
        intensity: 0.2,
        weight: 1,
        minDelay: 150_000,
        maxDelay: 360_000,
        cooldown: 300_000,
        duration: 1_600,
      },
    ],
  },
];

if (process.env.NODE_ENV !== "production") {
  validateWorlds(worlds);
}

export const worldIds: readonly WorldId[] = worlds.map((world) => world.id);

export const defaultWorldId: WorldId = worlds[0].id;

export function getWorldById(id: WorldId): World {
  return worlds.find((world) => world.id === id) ?? worlds[0];
}
