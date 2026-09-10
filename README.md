# nimbus-endpoint-fanout

Reduced reproduction of [vercel/next.js#97802](https://github.com/vercel/next.js/issues/97802): Turbopack `next build` hangs in **JS compilation** (`Creating an optimized production build`), never prints `Compiled successfully`, `.next` stays ~1 MB, RSS climbs to OOM.

This is **not** a copy of a product app. Invented trees:

| Tree | Path | What it stands in for |
|---|---|---|
| **records** | `app/api/records/**` | A REST-ish resource API: one dynamic `[recordId]` folder with many operations, plus a `public/` folder. ~60 `route.ts` files. |
| **ingress** | `app/api/ingress/**` | Inbound callbacks (one file per provider/event). ~48 `route.ts` files. |
| **kernel** | `lib/kernel` | Zod schemas, 2000 modules, one barrel. |
| **ops** | `lib/ops/*` | **One unique file per route** that `import *` the kernel — so Turbopack cannot collapse every handler to the same module identity. |

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

# B — records tree only (~60). Original stall repro.
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

`NIMBUS_MODULES=4000 pnpm generate:records` grows the kernel if 2000 is not enough to OOM on your box. First cut used 800 modules and `import()` inside the kernel — that **compiled in ~74s / ~5 GiB** and did **not** stall. Static `import *` of the barrel is required.

## What “stall” looks like

- Log stuck on `Creating an optimized production build`
- Next prints `⨯ turbopackFileSystemCacheForBuild`
- `.next` ≈ 1 MB / ~32 files
- RSS climbs until the memory cap; never `Compiled successfully`
