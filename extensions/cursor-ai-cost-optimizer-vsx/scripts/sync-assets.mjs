#!/usr/bin/env node
/**
 * Copies the Cursor plugin into this extension so it can set up the same cost optimizer without the
 * plugin marketplace, and generates the single-file entry the per-platform hook binaries are built from.
 *
 *   resources/plugin/{rules,agents,skills,commands,scripts,config,hooks/hooks.json,assets/logo.svg}
 *                                         straight copy of the plugin = PLUGIN_ROOT for extension users
 *   resources/entry/scripts/*             bundle-only copies of scripts/ whose main() guards are keyed on CCO_HOOK_MAIN
 *   resources/entry/cco-hook-bundle.mjs   GENERATED entry (see below)
 *   resources/icon.png                    extension icon rendered from the plugin logo (ImageMagick `convert`)
 *
 * Usage: node scripts/sync-assets.mjs [--plugin-dir <path>]
 * Default plugin dir: ../../plugins/cursor-ai-cost-optimizer (relative to the extension root).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const pluginDir = path.resolve(
  argValue("--plugin-dir") || process.env.CCO_PLUGIN_DIR || path.join(extensionRoot, "..", "..", "plugins", "cursor-ai-cost-optimizer")
);
if (!fs.existsSync(path.join(pluginDir, "hooks", "hooks.json"))) {
  console.error(`sync-assets: plugin dir not found or missing hooks/hooks.json: ${pluginDir}`);
  process.exit(1);
}

const SKIP = new Set([".DS_Store", "node_modules"]);
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) {
      continue;
    }
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      count += 1;
    }
  }
  return count;
}

const resources = path.join(extensionRoot, "resources");
const pluginCopy = path.join(resources, "plugin");
const entryDir = path.join(resources, "entry");
fs.rmSync(pluginCopy, { recursive: true, force: true });
fs.rmSync(entryDir, { recursive: true, force: true });
// old layouts
for (const stale of ["cursor", "cco"]) {
  fs.rmSync(path.join(resources, stale), { recursive: true, force: true });
}

const summary = {};
for (const dir of ["rules", "agents", "skills", "commands", "scripts", "config", "hooks"]) {
  if (!fs.existsSync(path.join(pluginDir, dir))) {
    console.error(`sync-assets: plugin is missing ${dir}/`);
    process.exit(1);
  }
  summary[`resources/plugin/${dir}`] = copyDir(path.join(pluginDir, dir), path.join(pluginCopy, dir));
}
if (fs.existsSync(path.join(pluginDir, "assets", "logo.svg"))) {
  fs.mkdirSync(path.join(pluginCopy, "assets"), { recursive: true });
  fs.copyFileSync(path.join(pluginDir, "assets", "logo.svg"), path.join(pluginCopy, "assets", "logo.svg"));
}
for (const f of ["LICENSE"]) {
  if (fs.existsSync(path.join(pluginDir, f))) {
    fs.copyFileSync(path.join(pluginDir, f), path.join(pluginCopy, f));
  }
}

// The scripts must honor CCO_PLUGIN_ROOT (the plugin does; keep the check so a regression is loud).
const commonPath = path.join(pluginCopy, "scripts", "lib", "common.mjs");
if (!/PLUGIN_ROOT\s*=\s*process\.env\.CCO_PLUGIN_ROOT/.test(fs.readFileSync(commonPath, "utf8"))) {
  console.error("sync-assets: scripts/lib/common.mjs no longer honors CCO_PLUGIN_ROOT; the extension cannot relocate the plugin without it.");
  process.exit(1);
}

// --- Single-binary entry ------------------------------------------------------------------------
// cco-hook.mjs re-spawns process.execPath on sibling scripts, which cannot work inside a compiled binary.
// The generated entry mirrors its dispatch table but imports the scripts directly, after reading stdin once
// and re-exposing it as process.stdin. Inside a single-file bundle every module shares ONE import.meta.url,
// so the scripts' `import.meta.url === file://argv[1]` guard would fire for every guarded module that gets
// imported as a library too; the bundle therefore uses its own copies (resources/entry/scripts/) in which
// that guard is rewritten to `process.env.CCO_HOOK_MAIN === "<file>"`.
const dispatcher = fs.readFileSync(path.join(pluginCopy, "scripts", "cco-hook.mjs"), "utf8");
const mapMatch = dispatcher.match(/const SCRIPTS = \{([\s\S]*?)\};/);
const taskMatch = dispatcher.match(/toolName === "Task" \? "([^"]+)" : "([^"]+)"/);
if (!mapMatch || !taskMatch) {
  console.error("sync-assets: could not parse the SCRIPTS map / preToolUse branch from scripts/cco-hook.mjs");
  process.exit(1);
}
const scriptsMap = {};
for (const line of mapMatch[1].split("\n")) {
  const m = line.match(/^\s*([A-Za-z]+):\s*(?:"([^"]+)"|null)/);
  if (m) {
    scriptsMap[m[1]] = m[2] || null;
  }
}
const [taskScript, gateScript] = [taskMatch[1], taskMatch[2]];
// Setup commands the binary exposes besides hook events (machines without Node run these):
//   cco-hook init --workspace <ws> [--no-probe|--uninstall|--disable|--enable] | discover ... | install-hooks ...
const COMMANDS = { init: "cco-init.mjs", discover: "cco-discover-models.mjs", "install-hooks": "cco-install-hooks.mjs" };
const scriptFiles = [...new Set([...Object.values(scriptsMap).filter(Boolean), taskScript, gateScript, ...Object.values(COMMANDS)])].sort();
for (const f of scriptFiles) {
  if (!fs.existsSync(path.join(pluginCopy, "scripts", f))) {
    console.error(`sync-assets: dispatcher/commands reference missing script ${f}`);
    process.exit(1);
  }
}

const entryScriptsDir = path.join(entryDir, "scripts");
copyDir(path.join(pluginCopy, "scripts"), entryScriptsDir);
const MAIN_GUARD = "if (isMain(import.meta.url)";
let guardsRewritten = 0;
for (const name of fs.readdirSync(entryScriptsDir)) {
  if (!name.endsWith(".mjs")) {
    continue;
  }
  const file = path.join(entryScriptsDir, name);
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(MAIN_GUARD)) {
    continue;
  }
  // `if (isMain(import.meta.url)) {` and `if (isMain(import.meta.url) || process.env.CCO_HOOK_MAIN === "x") {`
  const rewritten = text.split(MAIN_GUARD).join(`if (process.env.CCO_HOOK_MAIN === ${JSON.stringify(name)}`);
  const header = "// bundle copy generated by scripts/sync-assets.mjs: main-guard keyed on CCO_HOOK_MAIN (see resources/entry/cco-hook-bundle.mjs)\n";
  const out = rewritten.startsWith("#!") ? rewritten.replace(/^(#![^\n]*\n)/, `$1${header}`) : `${header}${rewritten}`;
  fs.writeFileSync(file, out, "utf8");
  guardsRewritten += 1;
}
const unguarded = scriptFiles.filter((f) => !fs.readFileSync(path.join(entryScriptsDir, f), "utf8").includes("CCO_HOOK_MAIN"));

const entry = `// GENERATED by scripts/sync-assets.mjs from resources/plugin/scripts/cco-hook.mjs. Do not edit.
// Single-file entry for the compiled per-platform hook binary: \`cco-hook <event>\` (payload on stdin),
// installed by the extension at <workspace>/.cursor/cco/bin/cco-hook[.exe].
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

function readTrim(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

// PLUGIN_ROOT (config/, agents/, hooks/ live there; the scripts themselves are bundled). Same lookup order as
// the plugin's project-local shim: CCO_PLUGIN_DIR, <ws>/.cursor/cco/plugin-path.txt (next to this binary's
// bin/ dir; the extension points it at its bundled plugin copy), ~/.cursor/plugins/local, marketplace cache.
function pluginCandidates() {
  const out = [];
  if (process.env.CCO_PLUGIN_DIR) {
    out.push(process.env.CCO_PLUGIN_DIR);
  }
  const ccoDir = path.resolve(path.dirname(process.execPath), "..");
  const pinned = readTrim(path.join(ccoDir, "plugin-path.txt"));
  if (pinned) {
    out.push(pinned);
  }
  const plugins = path.join(os.homedir(), ".cursor", "plugins");
  out.push(path.join(plugins, "local", "cursor-ai-cost-optimizer"));
  try {
    const cache = path.join(plugins, "cache");
    for (const market of fs.readdirSync(cache)) {
      const mdir = path.join(cache, market);
      for (const name of fs.readdirSync(mdir)) {
        if (!name.startsWith("cursor-ai-cost-optimizer")) {
          continue;
        }
        const vdir = path.join(mdir, name);
        const versions = fs.readdirSync(vdir).map((v) => path.join(vdir, v)).filter((p) => fs.existsSync(path.join(p, "config", "defaults.json")));
        versions.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        out.push(...versions);
      }
    }
  } catch {}
  return out.filter((p) => p && fs.existsSync(path.join(p, "config", "defaults.json")));
}
if (!process.env.CCO_PLUGIN_ROOT) {
  process.env.CCO_PLUGIN_ROOT = pluginCandidates()[0] || path.resolve(path.dirname(process.execPath), "..", "plugin");
}

const SCRIPTS = ${JSON.stringify(scriptsMap, null, 2)};
const COMMANDS = ${JSON.stringify(COMMANDS, null, 2)};
const TASK_SCRIPT = ${JSON.stringify(taskScript)};
const GATE_SCRIPT = ${JSON.stringify(gateScript)};

// Static import() strings so the bundler includes every script; evaluation stays lazy.
const LOADERS = {
${scriptFiles.map((f) => `  ${JSON.stringify(f)}: () => import(${JSON.stringify(`./scripts/${f}`)}),`).join("\n")}
};

function readAllStdin() {
  return new Promise((resolve) => {
    let raw = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(raw));
  });
}

function fallback(event) {
  process.stdout.write(\`\${JSON.stringify(event === "beforeShellExecution" ? { continue: true, permission: "allow" } : { continue: true })}\\n\`);
}

async function main() {
  const event = String(process.argv[2] || "").trim();
  if (COMMANDS[event]) {
    // Setup command: argv passes through (parseArgs ignores the positional command word); stdin untouched.
    process.env.CCO_HOOK_MAIN = COMMANDS[event];
    await LOADERS[COMMANDS[event]]();
    return;
  }
  const raw = await readAllStdin();
  // Re-expose the captured payload: each script reads process.stdin itself.
  Object.defineProperty(process, "stdin", { value: Readable.from(raw ? [raw] : []), configurable: true, writable: true });
  let script = SCRIPTS[event];
  if (event === "preToolUse") {
    let toolName = "";
    try {
      toolName = String(JSON.parse(raw || "{}").tool_name || "");
    } catch {}
    script = toolName === "Task" ? TASK_SCRIPT : GATE_SCRIPT;
  }
  const loader = script ? LOADERS[script] : null;
  if (!loader) {
    fallback(event);
    return;
  }
  // Exactly one script runs its main(); modules it imports as libraries keep their guards closed.
  process.env.CCO_HOOK_MAIN = script;
  await loader();
}

main().catch(() => {
  process.stdout.write(\`\${JSON.stringify({ continue: true, permission: "allow" })}\\n\`);
});
`;
fs.writeFileSync(path.join(entryDir, "cco-hook-bundle.mjs"), entry, "utf8");
summary["resources/entry/cco-hook-bundle.mjs"] = `generated (${scriptFiles.length} targets; ${guardsRewritten} main-guards rewritten; unguarded: ${unguarded.join(", ") || "none"})`;

// --- Icon (Open VSX / marketplace require a raster icon inside the package) ------------------------
const iconPng = path.join(resources, "icon.png");
const logo = path.join(pluginCopy, "assets", "logo.svg");
if (fs.existsSync(logo)) {
  const res = spawnSync("convert", ["-background", "none", "-density", "512", logo, "-resize", "256x256", "-depth", "8", iconPng], { encoding: "utf8" });
  summary["resources/icon.png"] = res.status === 0 ? "rendered from plugin assets/logo.svg (256x256)" : `NOT rendered (convert exit ${res.status}: ${String(res.stderr || "").trim().slice(0, 120)})${fs.existsSync(iconPng) ? "; kept existing" : ""}`;
}

let pluginVersion = null;
try {
  pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginDir, ".cursor-plugin", "plugin.json"), "utf8")).version ?? null;
} catch {}
fs.writeFileSync(path.join(resources, "sync-info.json"), `${JSON.stringify({ pluginDir: path.relative(extensionRoot, pluginDir), pluginVersion, syncedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");

console.log(`sync-assets: copied from ${pluginDir}${pluginVersion ? ` (plugin v${pluginVersion})` : ""}`);
for (const [target, count] of Object.entries(summary)) {
  console.log(`  ${target}: ${typeof count === "number" ? `${count} file(s)` : count}`);
}
