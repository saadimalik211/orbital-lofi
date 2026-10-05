import type { GeneratedClip } from "@/audio/musicgenClient";

const DB_NAME = "orbital-lofi";
const STORE = "clips";
const memory = new Map<string, GeneratedClip>();

type StoredClip = { samples: ArrayBuffer; sampleRate: number };

function isStoredClip(value: unknown): value is StoredClip {
  if (!value || typeof value !== "object") {
    return false;
  }
  const clip = value as Partial<StoredClip>;
  return clip.samples instanceof ArrayBuffer && typeof clip.sampleRate === "number";
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

export async function readClip(key: string) {
  const cached = memory.get(key);
  if (cached) {
    return cached;
  }

  try {
    const db = await openDb();
    const clip = await new Promise<GeneratedClip | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => {
        const value: unknown = request.result;
        if (!isStoredClip(value)) {
          resolve(null);
          return;
        }
        resolve({
          samples: new Float32Array(value.samples),
          sampleRate: value.sampleRate,
        });
      };
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (clip) {
      memory.set(key, clip);
    }
    return clip;
  } catch {
    return null;
  }
}

export async function writeClip(key: string, clip: GeneratedClip) {
  memory.set(key, clip);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(
        {
          samples: new Float32Array(clip.samples).buffer,
          sampleRate: clip.sampleRate,
        },
        key,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Memory cache still holds the clip.
  }
}
