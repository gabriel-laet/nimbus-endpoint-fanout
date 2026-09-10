# nimbus-endpoint-fanout

Reduced reproduction of [vercel/next.js#97802](https://github.com/vercel/next.js/issues/97802): Turbopack `next build` hangs in **JS compilation** (`Creating an optimized production build`), never prints `Compiled successfully`, `.next` stays ~1 MB, RSS climbs to OOM.

This is **not** a copy of a product app. Invented trees:

| Tree | Path | What it stands in for |
|---|---|---|
| **records** | `app/api/records/**` | REST-ish resource API (~60 `route.ts`). |
| **ingress** | `app/api/ingress/**` | Inbound callbacks (~48 `route.ts`). |
| **desk** | `app/(desk)/**` | Matching `"use client"` pages (one per route). |
| **schema** | `lib/schema` | Cyclic Drizzle + Zod tables (default 1200). |
| **kit** | `lib/kit` | Cyclic `"use client"` widgets (default 1200). |
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

# B — records tree (default 180 routes × 1200 schema × 1200 kit)
pnpm generate:records
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

Measured on Linux, 16 vCPU, **MemoryMax=16G**, Next `16.4.0-canary.15`, `turbopackFileSystemCacheForBuild: false`:

| Command | Endpoints | Result |
|---|---|---|
| `pnpm generate:records && pnpm build` | 180 `route.ts` + 180 client pages | **SIGKILL 137** in 36s, RSS 16.0 GiB, never `Compiled`, `.next` 132 KB / 11 files |
| `pnpm generate:single && pnpm build` | 1 route + 1 page, **same** 1200+1200 kernel | **Compiled** in 14s, RSS 1.6 GiB, `.next` 7 MB, exit 0 |

Smaller graphs intern and compile (60×400 → 22s / 3.4 GiB; 120×800 → 51s / 9.3 GiB). Defaults are set at the OOM line.

`NIMBUS_ROUTES` / `NIMBUS_SCHEMA` / `NIMBUS_KIT` override the knobs.

## What “stall” looks like

- Log stuck on `Creating an optimized production build`
- Next prints `⨯ turbopackFileSystemCacheForBuild`
- `.next` ≈ 1 MB / ~32 files
- RSS climbs until the memory cap; never `Compiled successfully`
