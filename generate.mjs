#!/usr/bin/env node
/**
 * Synthetic App Router fan-out.
 *
 * Models a large Next app where many `route.ts` files all import one shared
 * kernel barrel (ORM/schema/auth-style). Not a copy of any real product.
 *
 * Trees:
 *   records  — REST-ish resource API under /api/records
 *   ingress  — inbound callback API under /api/ingress
 *
 * Modes:
 *   node generate.mjs                         both trees (default)
 *   node generate.mjs --tree=records
 *   node generate.mjs --tree=ingress
 *   node generate.mjs --tree=records --half=a|b
 *   node generate.mjs --tree=records --single   one route, same kernel imports
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const MODULES = Number(process.env.NIMBUS_MODULES || 2000);

const RECORD_OPS = [
  "overview",
  "items",
  "search",
  "media",
  "members",
  "settings",
  "audit",
  "export",
  "import",
  "clone",
  "archive",
  "restore",
  "tags",
  "notes",
  "files",
  "links",
  "watchers",
  "digest",
  "embed",
  "quota",
  "billing",
  "keys",
  "outbound",
  "events",
  "metrics",
  "alerts",
  "rules",
  "filters",
  "views",
  "boards",
  "timeline",
  "comments",
  "reactions",
  "pins",
  "shares",
  "access",
];

const RECORD_PUBLIC = [
  "lookup",
  "preview",
  "og",
  "sitemap",
  "feed",
  "oembed",
  "health",
  "robots",
  "manifest",
  "badge",
  "card",
  "rss",
  "atom",
  "opensearch",
  "embed-public",
  "download",
  "thumbnail",
  "poster",
  "caption",
  "transcript",
  "chapters",
  "playlist",
  "related",
  "trending",
];

const INGRESS_OPS = [
  "pulse",
  "relay",
  "echo",
  "beacon",
  "flare",
  "spark",
  "drift",
  "tide",
  "gulf",
  "brook",
  "ridge",
  "grove",
  "marsh",
  "cliff",
  "dune",
  "fjord",
  "atoll",
  "islet",
  "cape",
  "bay",
  "sound",
  "strait",
  "inlet",
  "delta",
  "basin",
  "plateau",
  "mesa",
  "butte",
  "crag",
  "vale",
  "glen",
  "hollow",
  "knoll",
  "spur",
  "col",
  "pass",
  "saddle",
  "cirque",
  "tarn",
  "firth",
  "loch",
  "mere",
  "pond",
  "rill",
  "beck",
  "burn",
  "runnel",
  "seep",
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

function kernelFile(i) {
  const id = String(i).padStart(4, "0");
  return `export const k${id} = {
  id: ${i},
  label: "kernel-${id}",
  blob: "${"nimbus-kernel-".repeat(64)}",
  fields: {
    a: ${i},
    b: "${id}",
    c: Array.from({ length: 8 }, (_, j) => ${i} + j),
  },
};

export function f${id}() {
  return k${id};
}
`;
}

function routeFile(symbol) {
  // import * forces the whole kernel barrel into this endpoint, matching
  // many real route.ts files each pulling shared schema/auth barrels.
  return `import * as kernel from "@/lib/kernel";

export const runtime = "nodejs";

export async function GET() {
  const n = kernel.f0000().id + kernel.k0000.fields.a;
  return Response.json({ tree: "${symbol}", n, modules: Object.keys(kernel).length });
}
`;
}

function singleRouteFile() {
  return `import * as kernel from "@/lib/kernel";

export const runtime = "nodejs";

export async function GET() {
  const n = kernel.f0000().id + kernel.k0000.fields.a;
  return Response.json({ tree: "single", n, modules: Object.keys(kernel).length });
}
`;
}

function writeKernel() {
  rm("lib/kernel");
  const exports = [];
  for (let i = 0; i < MODULES; i++) {
    const id = String(i).padStart(4, "0");
    write(`lib/kernel/mod-${id}.ts`, kernelFile(i));
    exports.push(`export * from "./mod-${id}";`);
  }
  write("lib/kernel/index.ts", `${exports.join("\n")}\n`);
}

function recordPaths() {
  const nested = RECORD_OPS.map((op) => `app/api/records/[recordId]/${op}/route.ts`);
  const pub = RECORD_PUBLIC.map((op) => `app/api/records/public/${op}/route.ts`);
  return [...nested, ...pub];
}

function ingressPaths() {
  return INGRESS_OPS.map((op) => `app/api/ingress/${op}/route.ts`);
}

function pick(paths) {
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

function main() {
  rm("app/api/records");
  rm("app/api/ingress");
  writeKernel();
  const { chosen, single, tree, half } = pick();
  if (single) {
    write("app/api/records/route.ts", singleRouteFile());
    console.log(
      JSON.stringify({ mode: "single", kernelModules: MODULES, routes: 1 }, null, 2)
    );
    return;
  }
  for (const rel of chosen) write(rel, routeFile(rel));
  console.log(
    JSON.stringify(
      {
        mode: "fanout",
        tree,
        half: half || null,
        kernelModules: MODULES,
        routes: chosen.length,
      },
      null,
      2
    )
  );
}

main();
