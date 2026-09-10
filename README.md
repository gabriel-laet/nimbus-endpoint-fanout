# nimbus-endpoint-fanout

Reduced reproductions of two Turbopack `next build` stalls
(vercel/next.js#97802). Both sit in **JS compilation** (`Creating an optimized production build`):
no `Compiled successfully`, `.next` stays tiny, RSS climbs until the cgroup kills the build.
Webpack builds the same trees.

This is **not** a copy of a product app. Invented trees:

| Tree | Path | What it stands in for |
|---|---|---|
| **records** | `app/api/records/**` | REST-ish resource API, one `route.ts` per operation. |
| **ingress** | `app/api/ingress/**` | Inbound callbacks, one `route.ts` per event. |
| **desk** | `app/(desk)/**` | Matching `"use client"` pages (one per route). |
| **schema** | `lib/schema` | Cyclic Drizzle + Zod tables (default 1200). |
| **kit** | `lib/kit` | Cyclic `"use client"` widgets (default 1200). |
| **ops / islands** | `lib/ops`, `lib/islands` | **Unique per endpoint.** Each op imports every schema file; each island imports every kit file. |
| **async** | `lib/async-kernel.ts`, `lib/lazy`, `lib/shared`, `lib/asyncops` | One server kernel shared by every route with D dynamic `import()`s; each lazily imported module pulls a few shared modules. |

## Two different stalls

### 1. Module analysis: O(M²) AST paths (`generate:records`, vercel/next.js#98522)

Every op/island imports M kernel modules and uses them in one `a + b + … + m` chain. The n-th
term sits n binary expressions deep, and Turbopack's ECMAScript analyzer stores the full AST path
for every effect and every retained code-generation entry, so each of these modules needs O(M²)
path entries while the whole app is analyzed. With 180 routes + 180 pages (540 big modules) that
is the 16 GiB SIGKILL below.

vercel/next.js#98522 (prefix-sharing `AstPath`) fixes this shape: the same build compiles at
~4 GB.

### 2. Chunking: one async chunk group per server entry (`generate:async`)

The async tree has no deep expressions and no big modules. Every `route.ts` imports the same
`lib/async-kernel.ts`, which holds D dynamic `import()`s. Turbopack computes the chunk group of a
dynamic import per *referencing chunk group* (keyed by that chunk group's available modules), and
every route is its own server entry, so the D async chunk groups are instantiated N times:
N × D chunk groups, each with its own chunk items, chunks and output assets. The build is not
stuck on any single chunk group; it grinds through hundreds of thousands of tiny ones while
memory grows.

**#98522 does not fix this shape**; it needs shared async chunk groups across referencing
server entries (one group per `import()` target, not one per parent entry).

## Setup

```bash
pnpm install   # or npm i
```

Next `16.4.0-canary.15` (the version the original stall was measured on). Linux, ~16 GiB cgroup, is where the original hung.

## Runs

```bash
# AstPath / #98522 stall — records tree (default 180 routes × 1200 schema × 1200 kit)
pnpm generate:records
pnpm build

# ONE route, same kernel imports (compiles)
pnpm generate:single
pnpm build

# Chunking stall — async tree (default 180 routes × 6000 dynamic imports)
pnpm generate:async
pnpm build

# ONE route, same dynamic imports (compiles)
pnpm generate:async-single
pnpm build

# Other variants
pnpm generate            # records + ingress
pnpm generate:records-half-a && pnpm build
pnpm generate:records-half-b && pnpm build
pnpm build:webpack       # control
```

Measured on Linux, 8 vCPU, **MemoryMax=16G** (`systemd-run`), Next `16.4.0-canary.15`,
`turbopackFileSystemCacheForBuild: false`. RSS is `/usr/bin/time -v` maximum resident set size.
The last column is canary.15 + #98522 + the shared-async-chunk-groups change (branch
`fix/turbopack-shared-async-chunk-groups`, second PR):

| Command | Shape | canary.15 | + #98522 (AstPath intern) | + shared async chunk groups |
|---|---|---|---|---|
| `pnpm generate:records && pnpm build` | 180 `route.ts` + 180 client pages, 1200 + 1200 kernel | **SIGKILL 137** after 74s, RSS 16.8 GB, `.next` 184 KB / 11 files | **Compiled in 39s**, RSS 4.06 GB | Compiled in 46s, RSS 4.07 GB |
| `pnpm generate:single && pnpm build` | 1 route + 1 page, same kernel | Compiled 11s, RSS 1.3 GB | Compiled 6s, RSS 1.15 GB | not run |
| `pnpm generate:async && pnpm build` | 180 `route.ts`, 6000 dynamic imports (1.08M async chunk groups without sharing) | **SIGKILL 137** after 7.5 min, RSS 16.8 GB, `.next` 132 KB / 11 files | **SIGKILL 137** after 8.1 min, RSS 16.8 GB, `.next` 132 KB / 11 files | **Compiled in 77s**, RSS 3.9 GB, `.next` 206 MB / 14,121 files |
| `NIMBUS_ASYNC=2400 pnpm generate:async && pnpm build` | 180 `route.ts`, 2400 dynamic imports (432k groups) | Compiled 2.7 min, RSS 9.8 GB | Compiled 2.9 min, RSS 9.7 GB | Compiled 31s, RSS 2.2 GB |
| `pnpm generate:async-single && pnpm build` | 1 route, 6000 dynamic imports | Compiled 17s, RSS 3.2 GB | (same kernel; intern does not change this) | Compiled 19s, RSS 3.0 GB |

`NIMBUS_ROUTES` / `NIMBUS_SCHEMA` / `NIMBUS_KIT` / `NIMBUS_ASYNC` / `NIMBUS_SHARED` override the
knobs.

## What “stall” looks like

- Log stuck on `Creating an optimized production build`
- Next prints `⨯ turbopackFileSystemCacheForBuild`
- `.next` ≈ 1 MB / ~32 files
- RSS climbs until the memory cap; never `Compiled successfully`
