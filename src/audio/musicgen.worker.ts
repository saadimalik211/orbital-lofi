/// <reference lib="webworker" />

import type {
  MusicgenIncomingMessage,
  MusicgenOutgoingMessage,
} from "./musicgenMessages";

const MODEL_ID = "Xenova/musicgen-small";
const MAX_NEW_TOKENS = 256;

let tokenizer: ((prompt: string) => Record<string, unknown>) | null = null;
let model: {
  generate: (inputs: Record<string, unknown>) => Promise<{
    data: ArrayLike<number> | Float32Array;
    dims?: number[];
  }>;
  config: {
    audio_encoder?: {
      sampling_rate?: number;
    };
  };
} | null = null;

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

function extractMono(tensor: {
  data: ArrayLike<number> | Float32Array;
  dims?: number[];
}) {
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

async function getRuntime() {
  if (tokenizer && model) {
    return { tokenizer, model };
  }

  const { AutoTokenizer, MusicgenForConditionalGeneration } = await import(
    "@huggingface/transformers"
  );

  tokenizer = (await AutoTokenizer.from_pretrained(MODEL_ID)) as unknown as (
    prompt: string,
  ) => Record<string, unknown>;
  model = (await MusicgenForConditionalGeneration.from_pretrained(MODEL_ID, {
    dtype: {
      text_encoder: "q4",
      decoder_model_merged: "q4",
      encodec_decode: "fp32",
    },
  })) as unknown as NonNullable<typeof model>;

  return { tokenizer, model };
}

async function handle(message: MusicgenIncomingMessage) {
  try {
    if (!tokenizer || !model) {
      post({ type: "status", id: message.id, status: "loading-model" });
    }

    const runtime = await getRuntime();

    if (message.type === "warmup") {
      post({ type: "ready", id: message.id });
      return;
    }

    post({ type: "status", id: message.id, status: "generating" });
    const inputs = runtime.tokenizer(message.prompt);
    const audioValues = await runtime.model.generate({
      ...inputs,
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: true,
      guidance_scale: 3,
    });

    const samples = new Float32Array(extractMono(audioValues));
    const sampleRate = runtime.model.config.audio_encoder?.sampling_rate ?? 32000;
    post(
      { type: "result", id: message.id, samples, sampleRate },
      [samples.buffer],
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error("Music generation failed");
    post({ type: "error", id: message.id, message: err.message });
  }
}

let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<MusicgenIncomingMessage>) => {
  queue = queue.then(() => handle(event.data)).catch(() => undefined);
};
