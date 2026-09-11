/**
 * Turbopack loader: make app-internal lazy imports static for the SERVER build.
 *
 * Workaround for vercel/next.js#97802. Turbopack computes one async chunk
 * group per (server entry x `import()` target). When N route entries share a
 * kernel with D dynamic imports that is N x D chunk groups (`generate:async`
 * here: 180 x 6000 = 1.08M), and the production compile never finishes.
 *
 * This loader rewrites `import("<app-internal specifier>")` into
 * `Promise.resolve().then(() => require("<specifier>"))`. For the bundler that
 * is a plain synchronous edge (the target lands in the entry's own chunk
 * group); at runtime the thunk still evaluates the module on first call, so
 * evaluation order, cycle behaviour and error propagation match `import()`
 * (`require` of an ES module returns its namespace object).
 *
 * Scope: literal specifiers starting with `@/`, `./` or `../`. Package
 * imports are left alone (they may be ESM-only externals). Imports carrying
 * `webpackIgnore` / `turbopackIgnore` are left alone. TypeScript
 * `import("x")` type positions are not call expressions and are untouched.
 *
 * Wire it under `turbopack.rules` with
 * `condition: { all: ["production", "node", { not: "browser" }, { not: "foreign" }] }`
 * so client bundles, edge and node_modules never see it (see next.config.ts).
 * Do NOT add a `path` condition: in 16.4.0-canary.15 it made the build ~5x
 * slower and ~2x heavier. If another plugin (e.g. withWorkflow) also registers
 * `*.ts` rules, register this one after it under a distinct full-path key (two stars, slash, star dot ts).
 */
const ts = require("typescript");

const APP_INTERNAL = /^(@\/|\.\.?\/)/;
const IGNORE = /\b(webpackIgnore|turbopackIgnore)\s*:\s*true\b/;

function transformStaticLazy(source, fileName) {
  if (!/import\s*\(/.test(source)) return { code: source, count: 0 };
  const scriptKind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : fileName.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const edits = [];

  // Everything between `import(` and the literal is comments/whitespace. Scan
  // that text directly: ts.getLeadingCommentRanges only collects comments that
  // follow a newline, so an inline `import(/* webpackIgnore: true */ "x")`
  // would otherwise be missed.
  function isIgnored(call) {
    const between = source.slice(call.arguments.pos, call.arguments[0].getStart(sf));
    return IGNORE.test(between);
  }

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      APP_INTERNAL.test(node.arguments[0].text) &&
      !isIgnored(node)
    ) {
      const spec = JSON.stringify(node.arguments[0].text);
      edits.push({
        start: node.getStart(sf),
        end: node.getEnd(),
        text: `Promise.resolve().then(() => require(${spec}))`,
      });
      // Do not descend: the argument is a literal.
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (edits.length === 0) return { code: source, count: 0 };
  let out = "";
  let cursor = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    out += source.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  out += source.slice(cursor);
  return { code: out, count: edits.length };
}

/** webpack-style loader entry (Turbopack `turbopack.rules` loaders). */
function loader(source) {
  const fileName = (this && this.resourcePath) || "module.ts";
  const result = transformStaticLazy(String(source), fileName);
  if (process.env.GARAGEM_TURBOPACK_STATIC_LAZY_DEBUG) {
    // Loaders run in a worker whose stderr may not reach the build log; append
    // to the file named by the env var instead (diagnostics only).
    try {
      require("fs").appendFileSync(
        process.env.GARAGEM_TURBOPACK_STATIC_LAZY_DEBUG,
        `${result.count}\t${fileName}\n`,
      );
    } catch {}
  }
  return result.code;
}

module.exports = loader;
module.exports.transformStaticLazy = transformStaticLazy;
