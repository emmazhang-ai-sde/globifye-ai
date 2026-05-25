import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Fix: Turbopack detects a package-lock.json in the home directory and
    // incorrectly uses ~/  as the project root. This tells it explicitly where
    // the project root is, which also fixes the CSS source-map parsing error.
    root: __dirname,
  },
};

export default nextConfig;
