import type { MusicgenOutgoingMessage, MusicgenStatus } from "./musicgenMessages";

export type GeneratedClip = {
  samples: Float32Array;
  sampleRate: number;
};

type PendingRequest = {
  resolve: (clip: GeneratedClip | null) => void;
  reject: (error: Error) => void;
  onStatus?: (status: MusicgenStatus) => void;
};

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, PendingRequest>();

function handleMessage(event: MessageEvent<MusicgenOutgoingMessage>) {
  const message = event.data;
  const request = pending.get(message.id);
  if (!request) {
    return;
  }

  if (message.type === "status") {
    request.onStatus?.(message.status);
    return;
  }

  pending.delete(message.id);

  if (message.type === "error") {
    request.reject(new Error(message.message));
    return;
  }

  if (message.type === "ready") {
    request.resolve(null);
    return;
  }

  request.resolve({
    samples: message.samples,
    sampleRate: message.sampleRate,
  });
}

function getWorker() {
  if (worker) {
    return worker;
  }

  worker = new Worker(new URL("./musicgen.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = handleMessage;
  worker.onerror = (event) => {
    const error = new Error(event.message || "MusicGen worker failed");
    for (const [id, request] of pending) {
      request.reject(error);
      pending.delete(id);
    }
  };

  return worker;
}

export function warmupMusicgen(onStatus?: (status: MusicgenStatus) => void) {
  const id = (nextRequestId += 1);
  getWorker().postMessage({ type: "warmup", id });

  return new Promise<void>((resolve, reject) => {
    pending.set(id, {
      resolve: () => resolve(),
      reject,
      onStatus,
    });
  });
}

export function generateMusicClip(
  prompt: string,
  onStatus?: (status: MusicgenStatus) => void,
) {
  const id = (nextRequestId += 1);
  getWorker().postMessage({ type: "generate", id, prompt });

  return new Promise<GeneratedClip>((resolve, reject) => {
    pending.set(id, {
      resolve: (clip) => {
        if (!clip) {
          reject(new Error("No clip returned"));
          return;
        }
        resolve(clip);
      },
      reject,
      onStatus,
    });
  });
}
