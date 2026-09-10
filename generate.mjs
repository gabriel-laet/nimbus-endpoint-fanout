#!/usr/bin/env node
/**
 * Two failure shapes, selected with --tree:
 *
 *   --tree=records | --tree=ingress | (default: both)
 *     N route.ts + N "use client" pages whose per-endpoint op/island import a cyclic
 *     schema/kit kernel through 1200-term `a + b + …` chains. Stalls Turbopack in module
 *     analysis: O(M²) AST paths per module (vercel/next.js#97802, fixed by
 *     vercel/next.js#98522).
 *
 *   --tree=async
 *     N route.ts that share one server kernel holding D dynamic `import()`s. Stalls
 *     Turbopack in chunking: every server entry gets its own copy of every async chunk
 *     group (N × D chunk groups). Not fixed by #98522.
 *
 * Scale knobs (env):
 *   NIMBUS_ROUTES  default 180
 *   NIMBUS_SCHEMA  default 1200  (cyclic drizzle+zod tables, records/ingress)
 *   NIMBUS_KIT     default 1200  (cyclic "use client" widgets, records/ingress)
 *   NIMBUS_ASYNC   default 6000  (dynamically imported modules, async)
 *   NIMBUS_SHARED  default 300   (modules shared by the dynamically imported ones, async)
 *
 * --single still emits one route (+ one page for records/ingress) that pulls the same kernel.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = Number(process.env.NIMBUS_ROUTES || 180);
const SCHEMA = Number(process.env.NIMBUS_SCHEMA || 1200);
const KIT = Number(process.env.NIMBUS_KIT || 1200);
const ASYNC = Number(process.env.NIMBUS_ASYNC || 6000);
const SHARED = Number(process.env.NIMBUS_SHARED || 300);
// How many shared modules each dynamically imported module pulls in.
const SHARED_PER_LAZY = 30;

// Deterministic pseudo-random pick, so the per-route and per-lazy-module subsets of the shared
// modules overlap differently for (almost) every route × lazy module pair. A lazily imported
// module's chunk group excludes the shared modules the referencing route already has, so every
// route gets its own variant of every async chunk group.
function pick(a, b) {
  return ((Math.imul(a + 1, 2654435761) ^ Math.imul(b + 1, 40503)) >>> 0) % 2 === 0;
}

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
function rm(rel) {
  fs.rmSync(path.join(root, rel), { recursive: true, force: true });
}
function write(rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}
function pad(i, n = 4) {
  return String(i).padStart(n, "0");
}

function schemaFile(i) {
  const id = pad(i);
  const next = pad((i + 1) % SCHEMA);
  const prev = pad((i + SCHEMA - 1) % SCHEMA);
  return `import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import { t${next} } from "./t${next}";
import { t${prev} } from "./t${prev}";

export const schema${id} = z.object({
  id: z.number(),
  name: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  meta: z.record(z.string()),
});

export const t${id} = pgTable("t${id}", {
  id: integer("id").primaryKey(),
  name: text("name"),
  body: text("body"),
});

export const walk${id} = () => t${next}.name + t${prev}.name + t${id}.name;
`;
}

function kitFile(i) {
  const id = pad(i);
  const next = pad((i + 1) % KIT);
  const prev = pad((i + KIT - 1) % KIT);
  return `"use client";

import { c${next} } from "./c${next}";
import { c${prev} } from "./c${prev}";

export function c${id}() {
  return "kit-${id}:" + c${next}.length + c${prev}.length;
}
`;
}

function opFile(id, nSchema) {
  const lines = [];
  const uses = [];
  for (let i = 0; i < nSchema; i++) {
    const p = pad(i);
    lines.push(`import { walk${p}, schema${p} } from "@/lib/schema/t${p}";`);
    uses.push(`walk${p}().length`);
  }
  return `${lines.join("\n")}

export function run_${id}() {
  return ${uses.join(" + ")};
}
`;
}

function islandFile(id, nKit) {
  const lines = [];
  const uses = [];
  for (let i = 0; i < nKit; i++) {
    const p = pad(i);
    lines.push(`import { c${p} } from "@/lib/kit/c${p}";`);
    uses.push(`c${p}()`);
  }
  return `"use client";

${lines.join("\n")}

export function Island_${id}() {
  return <span>{${uses.join(" + ")}}</span>;
}
`;
}

function routeFile(id) {
  return `import { run_${id} } from "@/lib/ops/${id}";
import { Island_${id} } from "@/lib/islands/${id}";

export const runtime = "nodejs";

export async function GET() {
  void Island_${id};
  return Response.json({ id: "${id}", n: run_${id}() });
}
`;
}

function pageFile(id) {
  return `"use client";

import { Island_${id} } from "@/lib/islands/${id}";

export default function Page_${id}() {
  return <main><Island_${id} /></main>;
}
`;
}

// --tree=async: the server kernel is one module with D dynamic imports. Each dynamically
// imported module pulls in a few shared modules that are only reachable through the dynamic
// imports, so every async chunk group has a small closure of its own.
function sharedFile(i) {
  const id = pad(i);
  return `export const s${id} = "shared-${id}";
export function shared${id}(x: number) {
  return x + ${i};
}
`;
}

function lazyFile(i) {
  const id = pad(i);
  const lines = [];
  const uses = [];
  for (let k = 0; k < SHARED_PER_LAZY; k++) {
    const p = pad((i * 7 + k * 13) % SHARED);
    lines.push(`import { shared${p} } from "@/lib/shared/s${p}";`);
    uses.push(`shared${p}(${k})`);
  }
  return `${lines.join("\n")}

export function lazy${id}() {
  return [${uses.join(", ")}].length;
}
`;
}

function asyncKernelFile(nAsync) {
  const imports = [];
  for (let i = 0; i < nAsync; i++) {
    const p = pad(i);
    imports.push(`  import("@/lib/lazy/l${p}").then((m) => m.lazy${p}()),`);
  }
  return `// Shared by every route: D dynamic imports, each is its own async chunk group.
export async function loadAll() {
  const results = await Promise.all([
${imports.join("\n")}
  ]);
  return results.length;
}
`;
}

function asyncOpFile(id, index) {
  const lines = [];
  const uses = [];
  for (let k = 0; k < SHARED; k++) {
    if (!pick(index, k)) continue;
    const p = pad(k);
    lines.push(`import { shared${p} } from "@/lib/shared/s${p}";`);
    uses.push(`shared${p}(${k})`);
  }
  return `${lines.join("\n")}

export function run_${id}() {
  return [${uses.join(", ")}].length;
}
`;
}

function asyncRouteFile(id) {
  return `import { loadAll } from "@/lib/async-kernel";
import { run_${id} } from "@/lib/asyncops/${id}";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ id: "${id}", n: run_${id}() + (await loadAll()) });
}
`;
}

function ids() {
  const tree = arg("tree", "all");
  const half = arg("half");
  const single = hasFlag("single");
  if (single) return { ids: ["single"], single: true, tree, half };
  const n = tree === "ingress" ? Math.floor(ROUTES / 2) : ROUTES;
  let list = Array.from({ length: n }, (_, i) => `op${pad(i, 3)}`);
  if (half === "a") list = list.slice(0, Math.ceil(list.length / 2));
  if (half === "b") list = list.slice(Math.ceil(list.length / 2));
  return { ids: list, single: false, tree, half };
}

function main() {
  rm("app/api/records");
  rm("app/api/ingress");
  rm("app/(desk)");
  rm("lib/ops");
  rm("lib/islands");
  rm("lib/schema");
  rm("lib/kit");
  rm("lib/lazy");
  rm("lib/shared");
  rm("lib/asyncops");
  rm("lib/async-kernel.ts");
  const { ids: list, single, tree, half } = ids();
  if (tree === "async") {
    for (let i = 0; i < SHARED; i++) write(`lib/shared/s${pad(i)}.ts`, sharedFile(i));
    for (let i = 0; i < ASYNC; i++) write(`lib/lazy/l${pad(i)}.ts`, lazyFile(i));
    write("lib/async-kernel.ts", asyncKernelFile(ASYNC));
    list.forEach((id, index) => {
      write(`lib/asyncops/${id}.ts`, asyncOpFile(id, index));
      write(`app/api/records/${id}/route.ts`, asyncRouteFile(id));
    });
    console.log(
      JSON.stringify(
        {
          mode: single ? "single" : "fanout",
          tree,
          async: ASYNC,
          shared: SHARED,
          routes: list.length,
          asyncChunkGroupsWithoutSharing: list.length * ASYNC,
        },
        null,
        2
      )
    );
    return;
  }
  for (let i = 0; i < SCHEMA; i++) write(`lib/schema/t${pad(i)}.ts`, schemaFile(i));
  for (let i = 0; i < KIT; i++) write(`lib/kit/c${pad(i)}.ts`, kitFile(i));
  for (const id of list) {
    write(`lib/ops/${id}.ts`, opFile(id, SCHEMA));
    write(`lib/islands/${id}.tsx`, islandFile(id, KIT));
    write(`app/api/records/${id}/route.ts`, routeFile(id));
    write(`app/(desk)/${id}/page.tsx`, pageFile(id));
  }
  console.log(
    JSON.stringify(
      {
        mode: single ? "single" : "fanout",
        tree,
        half: half || null,
        schema: SCHEMA,
        kit: KIT,
        routes: list.length,
        pages: list.length,
      },
      null,
      2
    )
  );
}

main();
