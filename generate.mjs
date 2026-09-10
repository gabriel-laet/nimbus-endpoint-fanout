#!/usr/bin/env node
/**
 * Synthetic App Router fan-out aimed at vercel/next.js#97802.
 *
 * Earlier cuts (shared barrel + import *) interned and compiled in seconds.
 * This cut gives every endpoint a *unique* server op and a *unique* client
 * island, both of which pull a cyclic Drizzle/Zod kernel plus a "use client"
 * kit — the same shape as many route.ts/page.tsx files each entering a fat
 * domain graph through a different file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = Number(process.env.NIMBUS_SCHEMA || 400);
const KIT = Number(process.env.NIMBUS_KIT || 400);

const RECORD_OPS = [
  "overview", "items", "search", "media", "members", "settings", "audit",
  "export", "import", "clone", "archive", "restore", "tags", "notes", "files",
  "links", "watchers", "digest", "embed", "quota", "billing", "keys", "outbound",
  "events", "metrics", "alerts", "rules", "filters", "views", "boards",
  "timeline", "comments", "reactions", "pins", "shares", "access",
];
const RECORD_PUBLIC = [
  "lookup", "preview", "og", "sitemap", "feed", "oembed", "health", "robots",
  "manifest", "badge", "card", "rss", "atom", "opensearch", "embedpublic",
  "download", "thumbnail", "poster", "caption", "transcript", "chapters",
  "playlist", "related", "trending",
];
const INGRESS_OPS = [
  "pulse", "relay", "echo", "beacon", "flare", "spark", "drift", "tide", "gulf",
  "brook", "ridge", "grove", "marsh", "cliff", "dune", "fjord", "atoll", "islet",
  "cape", "bay", "sound", "strait", "inlet", "delta", "basin", "plateau", "mesa",
  "butte", "crag", "vale", "glen", "hollow", "knoll", "spur", "col", "pass",
  "saddle", "cirque", "tarn", "firth", "loch", "mere", "pond", "rill", "beck",
  "burn", "runnel", "seep",
];

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
function pad(i) {
  return String(i).padStart(4, "0");
}
function ident(rel) {
  return rel
    .replace(/^app\/api\//, "")
    .replace(/\/route\.ts$/, "")
    .replace(/\[|\]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "_");
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
  const imports = [];
  const uses = [];
  for (let i = 0; i < nSchema; i++) {
    const p = pad(i);
    imports.push(`import { walk${p}, schema${p} } from "@/lib/schema/t${p}";`);
    uses.push(`walk${p}().length + schema${p}.safeParse({}).success`);
  }
  return `${imports.join("\n")}

export function run_${id}() {
  return ${uses.join(" + ")};
}
`;
}

function islandFile(id, nKit) {
  const imports = [];
  const uses = [];
  for (let i = 0; i < nKit; i++) {
    const p = pad(i);
    imports.push(`import { c${p} } from "@/lib/kit/c${p}";`);
    uses.push(`c${p}()`);
  }
  return `"use client";

${imports.join("\n")}

export function Island_${id}() {
  return <span>{${uses.join(" + ")}</span>;
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

function recordPaths() {
  return [
    ...RECORD_OPS.map((op) => `app/api/records/[recordId]/${op}/route.ts`),
    ...RECORD_PUBLIC.map((op) => `app/api/records/public/${op}/route.ts`),
  ];
}
function ingressPaths() {
  return INGRESS_OPS.map((op) => `app/api/ingress/${op}/route.ts`);
}

function pick() {
  const tree = arg("tree", "all");
  const half = arg("half");
  const single = hasFlag("single");
  let chosen = [];
  if (tree === "records" || tree === "all") chosen = chosen.concat(recordPaths());
  if (tree === "ingress" || tree === "all") chosen = chosen.concat(ingressPaths());
  if (half === "a") chosen = chosen.slice(0, Math.ceil(chosen.length / 2));
  if (half === "b") chosen = chosen.slice(Math.ceil(chosen.length / 2));
  return { chosen, single, tree, half };
}

function writeKernel() {
  rm("lib/schema");
  rm("lib/kit");
  for (let i = 0; i < SCHEMA; i++) write(`lib/schema/t${pad(i)}.ts`, schemaFile(i));
  for (let i = 0; i < KIT; i++) write(`lib/kit/c${pad(i)}.ts`, kitFile(i));
}

function main() {
  rm("app/api/records");
  rm("app/api/ingress");
  rm("app/(desk)");
  rm("lib/ops");
  rm("lib/islands");
  writeKernel();
  const { chosen, single, tree, half } = pick();
  const routes = single ? ["app/api/records/route.ts"] : chosen;
  for (const rel of routes) {
    const id = single ? "single" : ident(rel);
    write(`lib/ops/${id}.ts`, opFile(id, SCHEMA));
    write(`lib/islands/${id}.tsx`, islandFile(id, KIT));
    write(rel, routeFile(id));
    if (!single) {
      write(`app/(desk)/${id}/page.tsx`, pageFile(id));
    } else {
      write(`app/(desk)/single/page.tsx`, pageFile(id));
    }
  }
  console.log(
    JSON.stringify(
      {
        mode: single ? "single" : "fanout",
        tree,
        half: half || null,
        schema: SCHEMA,
        kit: KIT,
        routes: routes.length,
        pages: routes.length,
      },
      null,
      2
    )
  );
}

main();
