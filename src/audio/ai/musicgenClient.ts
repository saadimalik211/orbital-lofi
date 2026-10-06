import type { MusicgenOutgoingMessage, MusicgenStatus } from "@/audio/ai/musicgenMessages";

export type GeneratedClip = {
  samples: Float32Array;
  sampleRate: number;
};

type Pending = {
  resolve: (clip: GeneratedClip) => void;
  reject: (error: Error) => void;
  onStatus?: (status: MusicgenStatus) => void;
};

let worker: Worker | null = null;
let nextRequestId = 0;
let latestEpoch = 0;
let chain: Promise<void> = Promise.resolve();
const pending = new Map<number, Pending>();

function getWorker() {
  if (worker) {
    return worker;
  }

  worker = new Worker(new URL("./musicgen.worker.ts", import.meta.url), { type: "module" });
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
    request.resolve({ samples: message.samples, sampleRate: message.sampleRate });
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

function generate(prompt: string, onStatus?: (status: MusicgenStatus) => void) {
  const id = (nextRequestId += 1);
  getWorker().postMessage({ type: "generate", id, prompt });
  return new Promise<GeneratedClip>((resolve, reject) => {
    pending.set(id, { resolve, reject, onStatus });
  });
}

/**
 * One generation at a time. A newer epoch replaces anything still waiting,
 * and a result from an older epoch is dropped when it returns.
 */
export function requestMusicClip(
  epoch: number,
  prompt: string,
  onStatus?: (status: MusicgenStatus) => void,
) {
  latestEpoch = epoch;
  const run = chain.then(async () => {
    if (epoch !== latestEpoch) {
      return null;
    }
    return generate(prompt, onStatus);
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run.then((clip) => {
    if (epoch !== latestEpoch) {
      return null;
    }
    return clip;
  });
}
