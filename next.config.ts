import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin tracing to this project (a parent dir contains other lockfiles).
  outputFileTracingRoot: path.join(__dirname),
  // The chat route reads the docs index via a runtime path, which static
  // tracing won't detect — force-include both files in the function bundle.
  outputFileTracingIncludes: {
    "/api/chat": ["./data/docs-index.json", "./data/embeddings.bin"],
  },
};

export default nextConfig;
