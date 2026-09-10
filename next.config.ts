import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Already false in the original app. Persistence is not the failing phase.
    turbopackFileSystemCacheForBuild: false,
    turbopackInputSourceMaps: false,
  },
};

export default nextConfig;
