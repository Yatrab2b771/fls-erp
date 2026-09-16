// Minifies tsc's already-compiled dist/ output in place, one file at a
// time (no bundling) — the multi-file CommonJS structure tsc produces
// (relative requires between compiled files, Prisma client resolved via
// node_modules) stays intact; esbuild is only asked to shrink each
// file's own syntax. Run after `tsc`, via `npm run build:prod`, never
// against src/ directly.
import { build } from "esbuild";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, "..", "dist");

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collectJsFiles(full));
    else if (entry.endsWith(".js")) files.push(full);
  }
  return files;
}

const entryPoints = collectJsFiles(distDir);
if (entryPoints.length === 0) {
  console.error(`No .js files found under ${distDir} — run tsc first.`);
  process.exit(1);
}

await build({
  entryPoints,
  outdir: distDir,
  allowOverwrite: true,
  minify: true,
  platform: "node",
  target: "node18",
  format: "cjs", // matches tsconfig.json's "module": "commonjs"
  logLevel: "warning",
});

console.log(`Minified ${entryPoints.length} file(s) in ${distDir}`);
