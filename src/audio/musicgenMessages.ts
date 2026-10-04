export type MusicgenStatus = "loading-model" | "generating";

export type MusicgenIncomingMessage =
  | { type: "warmup"; id: number }
  | { type: "generate"; id: number; prompt: string };

export type MusicgenOutgoingMessage =
  | { type: "status"; id: number; status: MusicgenStatus }
  | { type: "ready"; id: number }
  | { type: "result"; id: number; samples: Float32Array; sampleRate: number }
  | { type: "error"; id: number; message: string };
