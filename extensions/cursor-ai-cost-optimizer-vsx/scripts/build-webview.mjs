#!/usr/bin/env node
/**
 * Bundle the cost-routed chat webview (webview-ui/src/main.tsx) into media/chat/index.js + index.css with the
 * extension's own esbuild. One JS file, one CSS file, fixed names: the extension loads them by path. No Vite:
 * its platform-specific rollup and esbuild binaries are hundreds of megabytes the extension does not need.
 *
 * The vendored Cline and Roo Code components use Tailwind utilities and path aliases (`@/…`, `@src/…`), so the
 * build resolves those aliases and runs Tailwind (v3, pure JavaScript) over the sources, appending its output to
 * index.css.
 */
import { build, context } from "esbuild";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  loader: { ".css": "css" },
  alias: { "@src": path.join(ui, "src", "vendor", "roo"), "@": path.join(ui, "src", "vendor", "cline") }
};

async function tailwind() {
  const require = createRequire(path.join(ui, "package.json"));
  const postcss = require("postcss");
  const tailwindcss = require("tailwindcss");
  const autoprefixer = require("autoprefixer");
  const input = readFileSync(path.join(ui, "src", "tailwind.css"), "utf8");
  const result = await postcss([tailwindcss({ config: path.join(ui, "tailwind.config.cjs") }), autoprefixer]).process(input, { from: path.join(ui, "src", "tailwind.css"), to: path.join(out, "tailwind.css") });
  const css = path.join(out, "index.css");
  writeFileSync(css, `${existsSync(css) ? readFileSync(css, "utf8") : ""}\n/* tailwind utilities used by the vendored components */\n${result.css}`);
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await tailwind();
  console.log("watching webview-ui …");
} else {
  await build(options);
  await tailwind();
}
