import type { AmbienceTrack } from "@/worlds/types";

const STORAGE_KEY = "orbital-lofi.ambience";

/** Keyed by ambience track id, so tracks sharing an id across worlds share a level. */
export type AmbiencePrefs = {
  volumes: Readonly<Record<string, number>>;
  muted: Readonly<Record<string, boolean>>;
};

const EMPTY_PREFS: AmbiencePrefs = { volumes: {}, muted: {} };

let current: AmbiencePrefs | null = null;
const listeners = new Set<() => void>();

export function clampVolume(value: number) {
  return Math.min(1, Math.max(0, value));
}

function readStorage(): AmbiencePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return EMPTY_PREFS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return EMPTY_PREFS;
    }
    const { volumes: rawVolumes, muted: rawMuted } = parsed as Record<string, unknown>;
    const volumes: Record<string, number> = {};
    const muted: Record<string, boolean> = {};
    if (rawVolumes && typeof rawVolumes === "object") {
      for (const [id, value] of Object.entries(rawVolumes)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          volumes[id] = clampVolume(value);
        }
      }
    }
    if (rawMuted && typeof rawMuted === "object") {
      for (const [id, value] of Object.entries(rawMuted)) {
        muted[id] = Boolean(value);
      }
    }
    return { volumes, muted };
  } catch {
    return EMPTY_PREFS;
  }
}

export function getAmbiencePrefs(): AmbiencePrefs {
  if (typeof window === "undefined") {
    return EMPTY_PREFS;
  }
  current ??= readStorage();
  return current;
}

export function getServerAmbiencePrefs(): AmbiencePrefs {
  return EMPTY_PREFS;
}

export function subscribeAmbiencePrefs(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateAmbiencePrefs(update: (prefs: AmbiencePrefs) => AmbiencePrefs) {
  current = update(getAmbiencePrefs());
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // private mode / quota: keep in-memory prefs
  }
  for (const listener of listeners) {
    listener();
  }
}

/** Effective gain for a track: muted → 0, otherwise the stored level or the track default. */
export function ambienceLevel(track: AmbienceTrack, prefs: AmbiencePrefs) {
  if (prefs.muted[track.id]) {
    return 0;
  }
  return prefs.volumes[track.id] ?? clampVolume(track.defaultVolume);
}
