const STORAGE_KEY = "orbital-lofi.ambience";

export type AmbiencePrefs = {
  volumes: Record<string, number>;
  muted: Record<string, boolean>;
};

const emptyPrefs: AmbiencePrefs = { volumes: {}, muted: {} };

function clampVolume(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function loadAmbiencePrefs(): AmbiencePrefs {
  if (typeof window === "undefined") {
    return emptyPrefs;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return emptyPrefs;
    }
    const parsed = JSON.parse(raw) as Partial<AmbiencePrefs>;
    const volumes: Record<string, number> = {};
    const muted: Record<string, boolean> = {};
    if (parsed.volumes && typeof parsed.volumes === "object") {
      for (const [id, value] of Object.entries(parsed.volumes)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          volumes[id] = clampVolume(value);
        }
      }
    }
    if (parsed.muted && typeof parsed.muted === "object") {
      for (const [id, value] of Object.entries(parsed.muted)) {
        muted[id] = Boolean(value);
      }
    }
    return { volumes, muted };
  } catch {
    return emptyPrefs;
  }
}

export function saveAmbiencePrefs(prefs: AmbiencePrefs) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // private mode / quota
  }
}
