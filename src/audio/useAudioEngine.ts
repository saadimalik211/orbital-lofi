"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readClip, writeClip } from "@/audio/clipCache";
import {
  pcmToAudioBuffer,
  startLoopingBuffer,
  type LoopHandle,
} from "@/audio/loopBuffer";
import {
  generateMusicClip,
  warmupMusicgen,
  type GeneratedClip,
} from "@/audio/musicgenClient";
import {
  loadAmbienceBuffer,
  preloadWorldAmbience,
  startAmbienceVoice,
  stopAmbienceVoices,
  type AmbienceVoice,
} from "@/audio/ambienceEngine";
import {
  loadAmbiencePrefs,
  saveAmbiencePrefs,
} from "@/audio/ambiencePrefs";
import {
  createProceduralEngine,
  type ProceduralEngine,
} from "@/audio/proceduralEngine";
import type { AmbienceTrack, World } from "@/worlds/types";

export type AudioEngineStatus =
  | "idle"
  | "loading-model"
  | "generating"
  | "bed"
  | "ready"
  | "error";

function fadeTo(gain: GainNode, value: number, seconds = 0.85) {
  const now = gain.context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(value, now + seconds);
}

function clampVolume(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function useAudioEngine() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.55);
  const [status, setStatus] = useState<AudioEngineStatus>("idle");
  const [ambienceVolumes, setAmbienceVolumes] = useState<Record<string, number>>(
    {},
  );
  const [ambienceMuted, setAmbienceMuted] = useState<Record<string, boolean>>(
    {},
  );

  const contextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const bedGainRef = useRef<GainNode | null>(null);
  const clipGainRef = useRef<GainNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const ambienceBusRef = useRef<GainNode | null>(null);
  const engineRef = useRef<ProceduralEngine | null>(null);
  const loopRef = useRef<LoopHandle | null>(null);
  const bootRef = useRef<Promise<void> | null>(null);
  const playingRef = useRef(false);
  const toggleAtRef = useRef(0);
  const volumeRef = useRef(0.55);
  const requestRef = useRef(0);
  const ambienceTokenRef = useRef(0);
  const voicesRef = useRef(new Map<string, AmbienceVoice>());
  const ambienceVolumesRef = useRef<Record<string, number>>({});
  const ambienceMutedRef = useRef<Record<string, boolean>>({});
  const eventSoundRef = useRef<{ stop: () => void } | null>(null);
  const eventTokenRef = useRef(0);

  const ensureGraph = useCallback(async () => {
    if (!contextRef.current) {
      const context = new AudioContext();
      const masterGain = context.createGain();
      const bedGain = context.createGain();
      const clipGain = context.createGain();
      const outputGain = context.createGain();
      const ambienceBus = context.createGain();
      masterGain.gain.value = volumeRef.current;
      bedGain.gain.value = 1;
      clipGain.gain.value = 0;
      outputGain.gain.value = 1;
      ambienceBus.gain.value = 1;
      bedGain.connect(masterGain);
      clipGain.connect(masterGain);
      ambienceBus.connect(masterGain);
      masterGain.connect(outputGain);
      outputGain.connect(context.destination);
      contextRef.current = context;
      masterGainRef.current = masterGain;
      bedGainRef.current = bedGain;
      clipGainRef.current = clipGain;
      outputGainRef.current = outputGain;
      ambienceBusRef.current = ambienceBus;
    }

    void contextRef.current.resume();

    if (!bootRef.current) {
      const context = contextRef.current;
      const bedGain = bedGainRef.current;
      bootRef.current = createProceduralEngine(context, bedGain!).then((engine) => {
        engineRef.current = engine;
      }).catch((error: unknown) => {
        bootRef.current = null;
        throw error;
      });
    }

    await bootRef.current;
    if (contextRef.current.state === "suspended") {
      await contextRef.current.resume();
    }
  }, []);

  const stopClip = useCallback(() => {
    loopRef.current?.stop(0.05);
    loopRef.current = null;
  }, []);

  const trackVolume = useCallback((track: AmbienceTrack) => {
    if (ambienceMutedRef.current[track.id]) {
      return 0;
    }
    const stored = ambienceVolumesRef.current[track.id];
    return typeof stored === "number" ? clampVolume(stored) : track.defaultVolume;
  }, []);

  const applyVoiceVolume = useCallback((trackId: string, value: number) => {
    const voice = voicesRef.current.get(trackId);
    if (!voice) {
      return;
    }
    const now = voice.gain.context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(value, now, 0.03);
  }, []);

  const stopAmbience = useCallback(() => {
    ambienceTokenRef.current += 1;
    stopAmbienceVoices(voicesRef.current);
  }, []);

  const startAmbience = useCallback(
    async (world: World) => {
      const token = (ambienceTokenRef.current += 1);
      stopAmbienceVoices(voicesRef.current);
      if (!playingRef.current) {
        return;
      }

      const context = contextRef.current;
      const bus = ambienceBusRef.current;
      if (!context || !bus) {
        return;
      }

      const loaded = await Promise.all(
        world.ambience.map(async (track) => {
          try {
            return {
              track,
              buffer: await loadAmbienceBuffer(context, track.src),
            };
          } catch {
            return { track, buffer: null };
          }
        }),
      );

      if (token !== ambienceTokenRef.current || !playingRef.current) {
        return;
      }

      for (const item of loaded) {
        if (!item.buffer) {
          continue;
        }
        const voice = startAmbienceVoice(
          context,
          bus,
          item.track,
          item.buffer,
          trackVolume(item.track),
        );
        voicesRef.current.set(item.track.id, voice);
      }
    },
    [trackVolume],
  );

  const playClip = useCallback(
    (clip: GeneratedClip) => {
      const context = contextRef.current;
      const clipGain = clipGainRef.current;
      const bedGain = bedGainRef.current;
      if (!context || !clipGain || !bedGain || clip.samples.length < 1024) {
        return;
      }

      const buffer = pcmToAudioBuffer(context, clip.samples, clip.sampleRate);
      stopClip();
      fadeTo(bedGain, 0);
      fadeTo(clipGain, 1);
      loopRef.current = startLoopingBuffer(context, clipGain, buffer);
      engineRef.current?.stop();
      setStatus("ready");
    },
    [stopClip],
  );

  const requestNeuralClip = useCallback(
    async (world: World) => {
      const token = (requestRef.current += 1);
      const cached = await readClip(world.id);
      if (token !== requestRef.current || !playingRef.current) {
        return;
      }
      if (cached) {
        playClip(cached);
        return;
      }

      try {
        const clip = await generateMusicClip(world.musicPrompt, (nextStatus) => {
          if (token === requestRef.current && playingRef.current) {
            setStatus(nextStatus);
          }
        });
        await writeClip(world.id, clip);
        if (token === requestRef.current && playingRef.current) {
          playClip(clip);
        }
      } catch {
        if (token === requestRef.current && playingRef.current) {
          setStatus("bed");
        }
      }
    },
    [playClip],
  );

  const startBed = useCallback(
    (world: World) => {
      const bedGain = bedGainRef.current;
      const clipGain = clipGainRef.current;
      if (bedGain && clipGain) {
        fadeTo(clipGain, 0, 0.4);
        fadeTo(bedGain, 1, 0.4);
      }
      stopClip();
      engineRef.current?.start(world.music);
      setStatus("bed");
    },
    [stopClip],
  );

  const stopEventSound = useCallback(() => {
    eventTokenRef.current += 1;
    eventSoundRef.current?.stop();
    eventSoundRef.current = null;
  }, []);

  const playEventSound = useCallback(
    async (src: string, volume = 0.5) => {
      const context = contextRef.current;
      const master = masterGainRef.current;
      if (!playingRef.current || !context || !master) {
        return false;
      }

      stopEventSound();
      const token = eventTokenRef.current;
      let buffer: AudioBuffer;
      try {
        buffer = await loadAmbienceBuffer(context, src);
      } catch {
        return false;
      }
      if (token !== eventTokenRef.current || !playingRef.current) {
        return false;
      }

      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = clampVolume(volume);
      source.connect(gain);
      gain.connect(master);

      const handle = {
        stop() {
          source.onended = null;
          const t = context.currentTime;
          gain.gain.cancelScheduledValues(t);
          gain.gain.setValueAtTime(gain.gain.value, t);
          gain.gain.linearRampToValueAtTime(0, t + 0.08);
          try {
            source.stop(t + 0.1);
          } catch {
            // already stopped
          }
          window.setTimeout(() => {
            source.disconnect();
            gain.disconnect();
          }, 150);
          if (eventSoundRef.current === handle) {
            eventSoundRef.current = null;
          }
        },
      };
      source.onended = () => handle.stop();
      eventSoundRef.current = handle;
      source.start();
      return true;
    },
    [stopEventSound],
  );

  const togglePlayback = useCallback(
    async (world: World) => {
      const now = performance.now();
      if (now - toggleAtRef.current < 120) {
        return;
      }
      toggleAtRef.current = now;

      if (playingRef.current) {
        requestRef.current += 1;
        playingRef.current = false;
        setIsPlaying(false);
        engineRef.current?.stop();
        stopClip();
        stopAmbience();
        stopEventSound();
        if (clipGainRef.current) {
          fadeTo(clipGainRef.current, 0, 0.05);
        }
        if (outputGainRef.current) {
          outputGainRef.current.gain.cancelScheduledValues(
            outputGainRef.current.context.currentTime,
          );
          outputGainRef.current.gain.value = 1;
        }
        setStatus("idle");
        return;
      }

      try {
        await ensureGraph();
        playingRef.current = true;
        setIsPlaying(true);
        startBed(world);
        void requestNeuralClip(world);
        void startAmbience(world);
      } catch (error) {
        console.error("Playback failed", error);
        playingRef.current = false;
        setIsPlaying(false);
        setStatus("error");
      }
    },
    [
      ensureGraph,
      requestNeuralClip,
      startAmbience,
      startBed,
      stopAmbience,
      stopClip,
      stopEventSound,
    ],
  );

  const beginWorldTransition = useCallback(
    (world: World) => {
      requestRef.current += 1;
      stopEventSound();
      const context = contextRef.current;
      if (context) {
        preloadWorldAmbience(context, world);
      }
      if (!playingRef.current || !outputGainRef.current) {
        return;
      }
      fadeTo(outputGainRef.current, 0, 0.55);
    },
    [stopEventSound],
  );

  const finishWorldTransition = useCallback(
    (world: World) => {
      const output = outputGainRef.current;
      if (!playingRef.current) {
        stopAmbience();
        if (output) {
          fadeTo(output, 1, 0.05);
        }
        return;
      }
      startBed(world);
      void requestNeuralClip(world);
      void startAmbience(world);
      if (output) {
        fadeTo(output, 1, 0.55);
      }
    },
    [requestNeuralClip, startAmbience, startBed, stopAmbience],
  );

  const onVolumeChange = useCallback((nextVolume: number) => {
    const clamped = clampVolume(nextVolume);
    volumeRef.current = clamped;
    setVolume(clamped);
    const gain = masterGainRef.current;
    if (gain) {
      gain.gain.setTargetAtTime(clamped, gain.context.currentTime, 0.02);
    }
  }, []);

  const persistPrefs = useCallback(() => {
    saveAmbiencePrefs({
      volumes: ambienceVolumesRef.current,
      muted: ambienceMutedRef.current,
    });
  }, []);

  const onAmbienceVolumeChange = useCallback(
    (trackId: string, nextVolume: number) => {
      const clamped = clampVolume(nextVolume);
      const nextVolumes = { ...ambienceVolumesRef.current, [trackId]: clamped };
      const nextMuted = { ...ambienceMutedRef.current, [trackId]: false };
      ambienceVolumesRef.current = nextVolumes;
      ambienceMutedRef.current = nextMuted;
      setAmbienceVolumes(nextVolumes);
      setAmbienceMuted(nextMuted);
      applyVoiceVolume(trackId, clamped);
      persistPrefs();
    },
    [applyVoiceVolume, persistPrefs],
  );

  const onAmbienceMuteToggle = useCallback(
    (trackId: string, defaultVolume: number) => {
      const nextMuted = {
        ...ambienceMutedRef.current,
        [trackId]: !ambienceMutedRef.current[trackId],
      };
      ambienceMutedRef.current = nextMuted;
      setAmbienceMuted(nextMuted);
      const stored = ambienceVolumesRef.current[trackId];
      const restored =
        typeof stored === "number" ? stored : clampVolume(defaultVolume);
      applyVoiceVolume(trackId, nextMuted[trackId] ? 0 : restored);
      persistPrefs();
    },
    [applyVoiceVolume, persistPrefs],
  );

  useEffect(() => {
    const prefs = loadAmbiencePrefs();
    ambienceVolumesRef.current = prefs.volumes;
    ambienceMutedRef.current = prefs.muted;
    setAmbienceVolumes(prefs.volumes);
    setAmbienceMuted(prefs.muted);
  }, []);

  useEffect(() => {
    const warm = () => {
      void warmupMusicgen((nextStatus) => {
        if (!playingRef.current) {
          setStatus(nextStatus);
        }
      })
        .then(() => {
          if (!playingRef.current) {
            setStatus("idle");
          }
        })
        .catch(() => {});
    };

    const idle = window.requestIdleCallback?.(warm, { timeout: 1200 });
    const fallback = typeof idle === "number" ? 0 : window.setTimeout(warm, 400);
    return () => {
      if (typeof idle === "number") {
        window.cancelIdleCallback?.(idle);
      }
      if (fallback) {
        window.clearTimeout(fallback);
      }
      requestRef.current += 1;
      ambienceTokenRef.current += 1;
      engineRef.current?.stop();
      loopRef.current?.stop(0.01);
      stopAmbienceVoices(voicesRef.current);
      stopEventSound();
    };
  }, [stopEventSound]);

  return {
    isPlaying,
    volume,
    status,
    ambienceVolumes,
    ambienceMuted,
    togglePlayback,
    beginWorldTransition,
    finishWorldTransition,
    setVolume: onVolumeChange,
    setAmbienceVolume: onAmbienceVolumeChange,
    toggleAmbienceMute: onAmbienceMuteToggle,
    playEventSound,
    stopEventSound,
  };
}
