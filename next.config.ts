import type { NextConfig } from "next";
import { resolve } from "node:path";

// STATIC_LAZY=1 enables the workaround loader: app-internal `import("@/…")`
// in server code becomes `Promise.resolve().then(() => require("@/…"))`, so
// Turbopack sees a synchronous edge instead of one async chunk group per
// (route × import() target). Runtime stays lazy.
const staticLazy = process.env.STATIC_LAZY === "1";

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Already false in the original app. Persistence is not the failing phase.
    turbopackFileSystemCacheForBuild: false,
    turbopackInputSourceMaps: false,
  },
  ...(staticLazy
    ? {
        turbopack: {
          rules: {
            "**/*.ts": [
              {
                condition: {
                  all: ["production", "node", { not: "browser" }, { not: "foreign" }],
                },
                loaders: [resolve(process.cwd(), "static-lazy-loader.cjs")],
              },
            ],
          },
        },
      }
    : {}),
};

export default nextConfig;
