"use client";

import { useAudioEngine } from "@/audio/useAudioEngine";
import { Hud } from "@/components/Hud";
import { WorldBackdrop } from "@/components/WorldBackdrop";
import { EnvironmentalEffects } from "@/effects/EnvironmentalEffects";
import { EnvironmentalEventLayer } from "@/events/EnvironmentalEventLayer";
import { useHudInteraction } from "@/hud/useHudInteraction";
import { useWorldTransition } from "@/worlds/useWorldTransition";
import { defaultWorldId, getWorldById, worldIds, worlds } from "@/worlds/worlds";

/** Max time the cover waits for a scene's first frame: shaders draw in a frame; media may need a fetch. */
const SHADER_REVEAL_MS = 650;
const MEDIA_REVEAL_MS = 2500;

export function WorldScene() {
  const audio = useAudioEngine(getWorldById(defaultWorldId));
  const { beginWorldTransition, finishWorldTransition } = audio;

  const transition = useWorldTransition({
    worldIds,
    initialWorldId: defaultWorldId,
    onBegin: (id) => beginWorldTransition(getWorldById(id)),
    onSwap: (id) => finishWorldTransition(getWorldById(id)),
    revealFallbackMs: (id) =>
      getWorldById(id).scene.type === "shader" ? SHADER_REVEAL_MS : MEDIA_REVEAL_MS,
  });
  const world = getWorldById(transition.visibleWorldId);

  const hud = useHudInteraction({
    onTogglePlayback: audio.togglePlayback,
    onToggleMute: audio.toggleMute,
    onPrevWorld: () => transition.stepWorld(-1),
    onNextWorld: () => transition.stepWorld(1),
  });

  return (
    <section
      className={`relative h-dvh w-full overflow-hidden bg-[#050807]${
        hud.hideCursor ? " cursor-none" : ""
      }`}
    >
      <WorldBackdrop
        key={world.id}
        scene={world.scene}
        onReady={transition.sceneReady}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_20%,rgba(2,6,5,0.18)_70%,rgba(2,6,5,0.55)_100%)]" />
      <EnvironmentalEffects key={`effects-${world.id}`} effects={world.effects} />
      <EnvironmentalEventLayer
        key={`events-${world.id}`}
        events={world.events}
        isPlaying={audio.isPlaying}
        suspended={transition.covered}
        playSound={audio.playEventSound}
        stopSound={audio.stopEventSound}
      />
      <div className={`world-cover${transition.covered ? " world-cover-on" : ""}`} />

      <Hud
        world={world}
        worlds={worlds}
        selectedWorldId={transition.targetWorldId}
        isPlaying={audio.isPlaying}
        status={audio.status}
        volume={audio.volume}
        visible={hud.hudVisible}
        idle={hud.idle}
        ambiencePrefs={audio.ambiencePrefs}
        onSelectWorld={transition.requestWorld}
        onTogglePlayback={audio.togglePlayback}
        onNextComposition={audio.nextComposition}
        onVolumeChange={audio.setVolume}
        onToggleHud={hud.toggleHud}
        onAmbienceVolumeChange={audio.setAmbienceVolume}
        onAmbienceMuteToggle={audio.toggleAmbienceMute}
      />
    </section>
  );
}
