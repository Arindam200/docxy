import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // This app lives beside the docxy CLI package, which has its own lockfile.
    // Pin the root here so Turbopack doesn't infer the repo root instead.
    root: import.meta.dirname,
  },
};

export default nextConfig;
