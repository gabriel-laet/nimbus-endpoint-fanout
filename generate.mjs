#!/usr/bin/env node
/**
 * Scale knobs (env):
 *   NIMBUS_ROUTES  default 120
 *   NIMBUS_SCHEMA  default 800   (cyclic drizzle+zod tables)
 *   NIMBUS_KIT     default 800   (cyclic "use client" widgets)
 *
 * --single still emits one route + one page that pull the same kernel.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = Number(process.env.NIMBUS_ROUTES || 180);
const SCHEMA = Number(process.env.NIMBUS_SCHEMA || 1200);
const KIT = Number(process.env.NIMBUS_KIT || 1200);

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
  for (let i = 0; i < SCHEMA; i++) write(`lib/schema/t${pad(i)}.ts`, schemaFile(i));
  for (let i = 0; i < KIT; i++) write(`lib/kit/c${pad(i)}.ts`, kitFile(i));
  const { ids: list, single, tree, half } = ids();
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
