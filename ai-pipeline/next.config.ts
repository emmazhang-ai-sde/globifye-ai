import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "sharp",
    "onnxruntime-node",
    "kokoro-js",
    "@huggingface/transformers",
  ],

  turbopack: {
    // Fix: Turbopack detects a package-lock.json in the home directory and
    // incorrectly uses ~/  as the project root. This tells it explicitly where
    // the project root is, which also fixes the CSS source-map parsing error.
    root: __dirname,
  },

  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      "onnxruntime-node$": false,
    };
    return config;
  },
};

export default nextConfig;