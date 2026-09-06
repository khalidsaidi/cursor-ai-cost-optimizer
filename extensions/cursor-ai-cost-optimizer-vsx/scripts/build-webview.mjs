#!/usr/bin/env node
/**
 * Bundle the cost-routed chat webview (webview-ui/src/main.tsx) into media/chat/index.js + index.css with the
 * extension's own esbuild. One JS file, one CSS file, fixed names: the extension loads them by path. No Vite:
 * its platform-specific rollup and esbuild binaries are hundreds of megabytes the extension does not need.
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(root, "webview-ui");
const out = path.join(root, "media", "chat");
const watch = process.argv.includes("--watch");

if (!existsSync(path.join(ui, "node_modules", "react"))) {
  console.error("webview-ui dependencies are missing: run `npm ci` in extensions/cursor-ai-cost-optimizer-vsx/webview-ui first.");
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const options = {
  entryPoints: [path.join(ui, "src", "main.tsx")],
  bundle: true,
  minify: !watch,
  sourcemap: false,
  format: "esm",
  target: ["es2020"],
  platform: "browser",
  outdir: out,
  entryNames: "index",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  nodePaths: [path.join(ui, "node_modules")],
  absWorkingDir: ui,
  logLevel: "info",
  loader: { ".css": "css" }
};

if (watch) {
  const { context } = await import("esbuild");
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching webview-ui …");
} else {
  await build(options);
}
