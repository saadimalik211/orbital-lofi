import type { MusicgenOutgoingMessage, MusicgenStatus } from "./musicgenMessages";

export type GeneratedClip = {
  samples: Float32Array;
  sampleRate: number;
};

type Pending<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  onStatus?: (status: MusicgenStatus) => void;
};

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, Pending<GeneratedClip | void>>();

function getWorker() {
  if (worker) {
    return worker;
  }

  worker = new Worker(new URL("./musicgen.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<MusicgenOutgoingMessage>) => {
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
      request.resolve();
      return;
    }
    request.resolve({
      samples: message.samples,
      sampleRate: message.sampleRate,
    });
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "MusicGen worker failed");
    for (const [id, request] of pending) {
      request.reject(error);
      pending.delete(id);
    }
  };

  return worker;
}

function send<T>(
  payload: { type: "warmup" } | { type: "generate"; prompt: string },
  onStatus?: (status: MusicgenStatus) => void,
) {
  const id = (nextRequestId += 1);
  getWorker().postMessage({ ...payload, id });
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: GeneratedClip | void) => void, reject, onStatus });
  });
}

export function warmupMusicgen(onStatus?: (status: MusicgenStatus) => void) {
  return send<void>({ type: "warmup" }, onStatus);
}

export function generateMusicClip(
  prompt: string,
  onStatus?: (status: MusicgenStatus) => void,
) {
  return send<GeneratedClip>({ type: "generate", prompt }, onStatus);
}
