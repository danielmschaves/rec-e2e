import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // googleapis is a large CJS package; keeping it external stops Next from
  // trying to bundle it into the server build.
  serverExternalPackages: ["googleapis", "bullmq", "ioredis", "@prisma/client"],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Server actions receive form posts from the app's own origin only.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
