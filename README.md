# nimbus-endpoint-fanout

Reduced reproduction of [vercel/next.js#97802](https://github.com/vercel/next.js/issues/97802): Turbopack `next build` hangs in **JS compilation** (`Creating an optimized production build`), never prints `Compiled successfully`, `.next` stays ~1 MB, RSS climbs to OOM.

This is **not** a copy of a product app. Invented trees:

| Tree | Path | What it stands in for |
|---|---|---|
| **records** | `app/api/records/**` | REST-ish resource API (~60 `route.ts`). |
| **ingress** | `app/api/ingress/**` | Inbound callbacks (~48 `route.ts`). |
| **desk** | `app/(desk)/**` | Matching `"use client"` pages (one per route). |
| **schema** | `lib/schema` | Cyclic Drizzle + Zod tables (default 400). |
| **kit** | `lib/kit` | Cyclic `"use client"` widgets (default 400). |
| **ops / islands** | `lib/ops`, `lib/islands` | **Unique per endpoint.** Each op imports every schema file; each island imports every kit file. |

Every generated `route.ts` imports `@/lib/kernel`. The unique module set is the same whether you have 1 route or 60.

## Observed in the original app (same shape)

- `experimental.turbopackFileSystemCacheForBuild: false` already. Stall is **before** `Compiled`, so not SSG and not `.next/cache/turbopack` persistence.
- Root layout / a small auth tree **compile**.
- Each fat API tree **stalls on its own**. Split a tree in half → each half **compiles**. Collapse a tree to **one** `route.ts` that still imports the same kernel → **compiles**.
- Webpack `next build --webpack` is fine.

## Setup

```bash
pnpm install   # or npm i
```

Next `16.4.0-canary.15` (the version the original stall was measured on). Linux, ~16 GiB cgroup, is where the original hung.

## Runs

```bash
# A — both trees, ~108 route.ts (expect stall / OOM on 16 GiB)
pnpm generate
pnpm build

# B — records tree (default 120 routes × 800 schema × 800 kit)
NIMBUS_ROUTES=120 NIMBUS_SCHEMA=800 NIMBUS_KIT=800 pnpm generate:records
pnpm build

# C — first / second half of records (each should compile)
pnpm generate:records-half-a && pnpm build
pnpm generate:records-half-b && pnpm build

# D — ONE route, same kernel imports (should compile)
pnpm generate:single
pnpm build

# Control
pnpm build:webpack
```

A shared `import *` barrel **interned** and compiled in seconds (~5 GiB). This generator uses unique per-route ops/islands plus cyclic schema/kit instead.

`NIMBUS_SCHEMA=600 NIMBUS_KIT=600 pnpm generate:records` to grow it.

## What “stall” looks like

- Log stuck on `Creating an optimized production build`
- Next prints `⨯ turbopackFileSystemCacheForBuild`
- `.next` ≈ 1 MB / ~32 files
- RSS climbs until the memory cap; never `Compiled successfully`
