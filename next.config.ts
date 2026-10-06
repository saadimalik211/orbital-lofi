import type { NextConfig } from "next";

/** Set in CI for a project site (`/repo-name`). Omit for local dev and domain-root Pages. */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  ...(basePath ? { basePath } : {}),
  // The MusicGen runtime is loaded only inside the audio worker, never on the server.
  serverExternalPackages: ["@huggingface/transformers"],
};

export default nextConfig;
