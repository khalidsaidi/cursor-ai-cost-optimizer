#!/usr/bin/env node
/**
 * Bundle the extension host code (src/extension.ts) into dist/extension.js with esbuild, so the runtime
 * dependencies the vendored Roo Code checkpoint service needs (simple-git, p-wait-for) ship inside the VSIX
 * without node_modules. tsc still emits every module to dist/ for the unit tests; this overwrites only the
 * entry file with the self-contained bundle.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "src", "extension.ts")],
  bundle: true,
  platform: "node",
  target: ["node18"],
  format: "cjs",
  external: ["vscode"],
  outfile: path.join(root, "dist", "extension.js"),
  sourcemap: false,
  minify: false,
  logLevel: "info",
  absWorkingDir: root
});
