/// <reference lib="webworker" />

import type { MusicgenIncomingMessage, MusicgenOutgoingMessage } from "./musicgenMessages";

const MODEL_ID = "Xenova/musicgen-small";
/** EnCodec frames are 20ms, so 750 tokens is about 15 seconds of audio. */
const MAX_NEW_TOKENS = 750;

const DTYPE = {
  text_encoder: "q4",
  decoder_model_merged: "q4",
  encodec_decode: "fp32",
} as const;

type Runtime = {
  tokenizer: (prompt: string) => Record<string, unknown>;
  model: {
    generate: (inputs: Record<string, unknown>) => Promise<{
      data: ArrayLike<number> | Float32Array;
      dims?: number[];
    }>;
    config: { audio_encoder?: { sampling_rate?: number } };
  };
};

let runtime: Runtime | null = null;

function post(message: MusicgenOutgoingMessage, transfer?: Transferable[]) {
  if (transfer?.length) {
    self.postMessage(message, { transfer });
  } else {
    self.postMessage(message);
  }
}

function toFloat32(data: ArrayLike<number> | Float32Array) {
  return data instanceof Float32Array ? data : Float32Array.from(data);
}

function extractMono(tensor: { data: ArrayLike<number> | Float32Array; dims?: number[] }) {
  const data = toFloat32(tensor.data);
  const dims = tensor.dims;
  if (!dims || dims.length <= 1) {
    return data.slice();
  }
  const samples = dims[dims.length - 1];
  const channels = Math.max(1, Math.floor(data.length / samples));
  if (channels <= 1) {
    return data.slice(0, samples);
  }
  const mono = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += data[channel * samples + i] ?? 0;
    }
    mono[i] = sum / channels;
  }
  return mono;
}

async function hasWebGpu() {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!gpu) {
      return false;
    }
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function loadModel(device: "webgpu" | "wasm"): Promise<Runtime> {
  const transformers = await import("@huggingface/transformers");
  transformers.env.allowLocalModels = false;
  if (transformers.env.backends.onnx.wasm) {
    transformers.env.backends.onnx.wasm.numThreads = 1;
  }
  const tokenizer = (await transformers.AutoTokenizer.from_pretrained(MODEL_ID)) as unknown as Runtime["tokenizer"];
  const model = (await transformers.MusicgenForConditionalGeneration.from_pretrained(MODEL_ID, {
    dtype: DTYPE,
    device,
  })) as unknown as Runtime["model"];
  return { tokenizer, model };
}

async function getRuntime() {
  if (runtime) {
    return runtime;
  }
  const webgpu = await hasWebGpu();
  try {
    runtime = await loadModel(webgpu ? "webgpu" : "wasm");
  } catch (error) {
    if (!webgpu) {
      throw error;
    }
    runtime = await loadModel("wasm");
  }
  return runtime;
}

async function handle(message: MusicgenIncomingMessage) {
  try {
    if (!runtime) {
      post({ type: "status", id: message.id, status: "loading-model" });
    }
    const active = await getRuntime();
    post({ type: "status", id: message.id, status: "generating" });
    const inputs = active.tokenizer(message.prompt);
    const audioValues = await active.model.generate({
      ...inputs,
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: true,
      guidance_scale: 3,
    });
    const samples = new Float32Array(extractMono(audioValues));
    const sampleRate = active.model.config.audio_encoder?.sampling_rate ?? 32000;
    post({ type: "result", id: message.id, samples, sampleRate }, [samples.buffer]);
  } catch (error) {
    const err = error instanceof Error ? error : new Error("Music generation failed");
    post({ type: "error", id: message.id, message: err.message });
  }
}

let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<MusicgenIncomingMessage>) => {
  queue = queue.then(() => handle(event.data)).catch(() => undefined);
};
