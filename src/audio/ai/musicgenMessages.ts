export type MusicgenStatus = "loading-model" | "generating";

export type MusicgenIncomingMessage =
  | { type: "generate"; id: number; prompt: string };

export type MusicgenOutgoingMessage =
  | { type: "status"; id: number; status: MusicgenStatus }
  | { type: "result"; id: number; samples: Float32Array; sampleRate: number }
  | { type: "error"; id: number; message: string };
