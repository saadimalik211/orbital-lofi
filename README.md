# Orbital Lofi

A cinematic sci-fi ambient listening terminal. Each world is an image, video or WebGL shader
scene with a music playlist (audio files and/or generated tracks: an instant procedural bed
plus an in-browser MusicGen clip), looping ambience, canvas/CSS environmental effects and
occasional random events.

No backend: everything runs in the browser. Mixer levels persist in `localStorage`;
generated clips are cached in IndexedDB.

```bash
npm install
npm run dev     # http://localhost:3000
npm run lint
npm run build
```

Shortcuts: `Space` play/pause · `H` hide HUD · `M` mute · `←`/`→` previous/next world.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/worlds/` | World config (`worlds.ts`), types, dev validator, `useWorldTransition` |
| `src/components/WorldScene.tsx` | Composes the layers and wires hooks together |
| `src/components/WorldBackdrop.tsx` | Renders the scene: image, video or shader |
| `src/backdrops/` | WebGL shader scenes (`shaders.ts`) and their renderer |
| `src/audio/` | Web Audio engine: music playlist (file player, procedural bed, MusicGen worker), ambience, event sounds |
| `src/effects/` | Rain / stars / particles canvas + CSS fog and flicker |
| `src/events/` | Event scheduler and event visuals |
| `src/hud/`, `src/components/Hud.tsx` | HUD idle/visibility, keyboard shortcuts, controls |

## How to add a new world

1. **Pick an id.** Kebab-case, e.g. `ice-moon`. Add it to the `WorldId` union in
   `src/worlds/types.ts`. The id is used for the asset folder and the music cache key.

2. **Add assets** under `public/worlds/<world-id>/`:

   ```
   public/worlds/ice-moon/
     scene/      background still or video: ice-moon.png, loop.mp4 …
     music/      playlist files: ice-moon-01.mp3 …
     ambience/   looping beds: wind.wav, generator.wav …
     events/     one-shot sounds and optional flyby art: crack.wav, probe.png …
   ```

   Short, seamlessly looping `.wav`/`.ogg`/`.mp3` files work best for ambience. Use only
   media you have the rights to. Every file is optional: a missing ambience track is skipped,
   a missing event sound stays silent, missing flyby art falls back to a CSS craft. In dev, the
   console logs one short `[orbital-lofi]` warning per missing file.

3. **Choose a scene.** One of:

   - `{ type: "image", src: "/worlds/ice-moon/scene/ice-moon.png" }`: a still, served through
     `next/image` (resized and re-encoded automatically), cropped to fill with `object-fit: cover`.
   - `{ type: "video", src: "/worlds/ice-moon/scene/loop.mp4", poster?: "…" }`: muted,
     looping, inline autoplay, also `object-fit: cover`.
   - `{ type: "shader", backdrop: "neon-skyline" }`: a GLSL scene from `BACKDROP_SHADERS` in
     `src/backdrops/shaders.ts` (`planet-orbit`, `neon-skyline`). Add new ones there and to
     `SceneBackdropId`.

   The transition cover lifts when the scene's first frame is ready (image loaded, video
   frame decoded, shader drawn) or after a timeout. A missing file leaves the dark
   background with effects and events still running.

4. **Add the config** to the `worlds` array in `src/worlds/worlds.ts`:

   ```ts
   {
     id: "ice-moon",
     name: "Ice Moon",
     year: 2203,
     scene: { type: "image", src: "/worlds/ice-moon/scene/ice-moon.png" },
     music: [
       { id: "ice-moon-01", title: "Glacier", src: "/worlds/ice-moon/music/ice-moon-01.mp3" },
       {
         id: "ice-moon-generated",
         title: "Frost Signal",
         generate: {
           prompt: "glacial ambient lofi, frozen moon base, soft bells, 70 bpm, looping instrumental",
           bed: { seed: 2203, bpm: 70, rootMidi: 55, swing: 0.55, brightness: 0.4, texture: 0.2 },
         },
       },
     ],
     ambience: [
       { id: "wind", name: "Wind", src: "/worlds/ice-moon/ambience/wind.wav", defaultVolume: 0.3 },
     ],
     effects: { particles: { type: "snow", intensity: 0.5 }, fog: { intensity: 0.2 } },
     events: [
       { id: "ice-crack", type: "sound", sound: { src: "/worlds/ice-moon/events/crack.wav" },
         weight: 1, minDelay: 60_000, maxDelay: 180_000, cooldown: 120_000, duration: 4_000 },
     ],
   }
   ```

   - **Music:** a playlist (at least one track) in play order. `title` is optional and shown
     in the HUD. `Next` (shown when there are 2+ tracks) fades out, moves to the following
     track, and fades in; the selection is remembered per world.
     - File track `{ id, src }`: plays once (don't bake in a loop), then the playlist
       advances. A missing/unplayable file is skipped.
     - Generated track `{ id, generate: { prompt, bed } }`: `bed` is an instant procedural
       groove; `prompt` renders a MusicGen clip in the browser that crossfades in. Loops until
       Next. `brightness` (0–1) opens the filter, `texture` (0–1) adds vinyl crackle. Changing
       the prompt invalidates the cached clip automatically.
   - **Ambience:** `id` keys the saved mixer level, so a `rain` track in two worlds shares one
     level. Use a distinct id if it should be independent. `defaultVolume` is 0–1.
   - **Effects:** each entry is optional; `intensity` is 0–1. Available: `rain`, `fog`,
     `stars`, `particles` (`dust` | `snow` | `atmosphere`), `flicker` (`screen` | `neon`).
   - **Events:** `flyby`, `streak`, `pulse` (`beacon` | `glitch` | `flash`) or `sound`.
     Timing is in ms: the next event is scheduled `minDelay`–`maxDelay` after the previous one,
     picked by `weight`, skipping events still in `cooldown`. Set `duration` to at least the
     length of the event's sound. Colors are `[r, g, b]` tuples.

5. **Check it.** `npm run dev` prints a single `World config issues` warning if ids collide,
   delays are inverted, levels are out of range, or asset paths sit outside the world's folder.
   In dev, the browser console exposes `orbitalEvents.list()` and
   `orbitalEvents.trigger("ice-crack")` to fire events on demand. This helper isn't included
   in production builds.
