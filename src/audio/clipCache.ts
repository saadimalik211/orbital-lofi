import type { GeneratedClip } from "@/audio/musicgenClient";
import type { WorldId } from "@/worlds/types";

const DB_NAME = "orbital-lofi";
const STORE = "clips";
const memory = new Map<WorldId, GeneratedClip>();

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

export async function readClip(id: WorldId) {
  const cached = memory.get(id);
  if (cached) {
    return cached;
  }

  try {
    const db = await openDb();
    const clip = await new Promise<GeneratedClip | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(id);
      request.onsuccess = () => {
        const value = request.result as
          | { samples: ArrayBuffer; sampleRate: number }
          | undefined;
        if (!value) {
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
      memory.set(id, clip);
    }
    return clip;
  } catch {
    return null;
  }
}

export async function writeClip(id: WorldId, clip: GeneratedClip) {
  memory.set(id, clip);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(
        {
          samples: new Float32Array(clip.samples).buffer,
          sampleRate: clip.sampleRate,
        },
        id,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Memory cache still holds the clip.
  }
}
