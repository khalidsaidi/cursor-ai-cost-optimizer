#!/usr/bin/env node
/**
 * Compile the hook dispatcher (resources/entry/cco-hook-bundle.mjs + everything it imports)
 * into ONE self-contained native executable per target, so installed workspaces need neither
 * Node.js nor a PATH: hooks.json calls "<workspace>/.cursor/cco/bin/cco-hook <event>".
 *
 *   node scripts/compile-binaries.mjs                 # all six targets (bun cross-compiles every one; Node SEA kept as a fallback for win32-arm64 with --sea)
 *   node scripts/compile-binaries.mjs --current-only  # host target only (CI/dev)
 *   node scripts/compile-binaries.mjs --target darwin-arm64
 *   node scripts/compile-binaries.mjs --skip-sea      # skip the win32-arm64 Node SEA build
 *
 * Output: dist-bin/<vscode-target>/cco-hook[.exe]
 * bun (~/.bun/bin/bun or BUN_PATH) is required for the bun targets; esbuild + postject (devDependencies)
 * and the official win-arm64 node.exe (downloaded to .cache/, or CCO_SEA_NODE_EXE) for the SEA target.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "resources", "entry", "cco-hook-bundle.mjs");
const outRoot = path.join(root, "dist-bin");
const cacheDir = path.join(root, ".cache");
const BIN_NAME = "cco-hook";
const NODE_SEA_VERSION = process.env.CCO_SEA_NODE_VERSION || "20.18.1";

export const TARGETS = {
  "linux-x64": { kind: "bun", bunTarget: "bun-linux-x64" },
  "linux-arm64": { kind: "bun", bunTarget: "bun-linux-arm64" },
  "darwin-x64": { kind: "bun", bunTarget: "bun-darwin-x64" },
  "darwin-arm64": { kind: "bun", bunTarget: "bun-darwin-arm64" },
  "win32-x64": { kind: "bun", bunTarget: "bun-windows-x64" },
  "win32-arm64": { kind: "bun", bunTarget: "bun-windows-arm64" }, // bun >= 1.3 cross-compiles Windows ARM64
};

export function hostTarget() {
  const plat = os.platform();
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  return `${plat === "win32" ? "win32" : plat === "darwin" ? "darwin" : "linux"}-${arch}`;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (res.status !== 0) {
    console.error(`command failed (${res.status ?? res.error?.message}): ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

function bunExe() {
  const candidates = [
    process.env.BUN_PATH,
    path.join(os.homedir(), ".bun", "bin", "bun"),
    path.join(os.homedir(), ".bun", "bin", "bun.exe"),
    "bun",
  ].filter(Boolean);
  for (const c of candidates) {
    const probe = spawnSync(c, ["--version"], { timeout: 10_000 });
    if (probe.status === 0) {
      return c;
    }
  }
  console.error("bun is required to compile the hook binaries (https://bun.sh); set BUN_PATH to point at it.");
  process.exit(1);
}

async function buildBun(target, bunTarget, dir) {
  const exe = target.startsWith("win32") ? ".exe" : "";
  run(bunExe(), ["build", "--compile", `--target=${bunTarget}`, entry, "--outfile", path.join(dir, `${BIN_NAME}${exe}`)]);
}

/** Fetch (and cache) the official win-arm64 node.exe for SEA injection, checksum-verified. */
async function winArm64NodeExe() {
  if (process.env.CCO_SEA_NODE_EXE && existsSync(process.env.CCO_SEA_NODE_EXE)) {
    return process.env.CCO_SEA_NODE_EXE;
  }
  const name = `node-v${NODE_SEA_VERSION}-win-arm64`;
  const cached = path.join(cacheDir, name, "node.exe");
  if (existsSync(cached)) {
    return cached;
  }
  await fs.mkdir(cacheDir, { recursive: true });
  const zip = path.join(cacheDir, `${name}.zip`);
  const CURL_RETRY = ["--retry", "4", "--retry-delay", "2", "--retry-all-errors"];
  run("curl", ["-fsSL", ...CURL_RETRY, "-o", zip, `https://nodejs.org/dist/v${NODE_SEA_VERSION}/${name}.zip`]);
  const sums = path.join(cacheDir, `SHASUMS256-${NODE_SEA_VERSION}.txt`);
  run("curl", ["-fsSL", ...CURL_RETRY, "-o", sums, `https://nodejs.org/dist/v${NODE_SEA_VERSION}/SHASUMS256.txt`]);
  const sumsText = await fs.readFile(sums, "utf8");
  const expected = sumsText.split("\n").find((l) => l.includes(`${name}.zip`))?.split(/\s+/)[0];
  const crypto = await import("node:crypto");
  const actual = crypto.createHash("sha256").update(await fs.readFile(zip)).digest("hex");
  if (!expected || expected !== actual) {
    console.error("win-arm64 node download failed its checksum");
    process.exit(1);
  }
  const hasUnzip = spawnSync("unzip", ["-v"], { timeout: 5000 }).status === 0;
  if (hasUnzip) {
    run("unzip", ["-oq", zip, "-d", cacheDir]);
  } else {
    run("tar", ["-xf", zip, "-C", cacheDir]);
  }
  return cached;
}

/** win32-arm64 (bun cannot target it): esbuild CJS bundle -> SEA blob -> injected into node.exe with postject. */
async function buildSea(dir) {
  let esbuild;
  try {
    esbuild = (await import("esbuild")).default;
  } catch {
    console.error("esbuild is required for the win32-arm64 SEA build: npm i -D esbuild postject (or pass --skip-sea)");
    process.exit(1);
  }
  const postjectCli = path.join(root, "node_modules", "postject", "dist", "cli.js");
  if (!existsSync(postjectCli)) {
    console.error("postject is required for the win32-arm64 SEA build: npm i -D postject (or pass --skip-sea)");
    process.exit(1);
  }
  const stage = path.join(cacheDir, "sea-stage");
  await fs.mkdir(stage, { recursive: true });
  const baseNode = await winArm64NodeExe();

  const bundle = path.join(stage, `${BIN_NAME}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: bundle,
    logLevel: "silent",
    // CJS has no import.meta; give every bundled module the executable's own file URL so the
    // scripts' `import.meta.url === file://argv[1]` main-guards keep working inside the SEA.
    banner: { js: 'var __ccoMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
    define: { "import.meta.url": "__ccoMetaUrl" },
  });
  const seaConfig = path.join(stage, `${BIN_NAME}.sea.json`);
  const blob = path.join(stage, `${BIN_NAME}.blob`);
  await fs.writeFile(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }), "utf8");
  run(process.execPath, ["--experimental-sea-config", seaConfig]);

  const outExe = path.join(dir, `${BIN_NAME}.exe`);
  await fs.copyFile(baseNode, outExe);
  run(process.execPath, [postjectCli, outExe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"]);
}

async function main() {
  if (!existsSync(entry)) {
    console.error(`missing ${path.relative(root, entry)}; run \`npm run sync:assets\` first`);
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const skipSea = argv.includes("--skip-sea");
  const currentOnly = argv.includes("--current-only") || argv.includes("--host-only");
  const targetFlag = argv.indexOf("--target");
  let wanted = targetFlag !== -1 ? [argv[targetFlag + 1]] : currentOnly ? [hostTarget()] : Object.keys(TARGETS);
  if (skipSea) {
    wanted = wanted.filter((t) => TARGETS[t]?.kind !== "sea");
  }
  for (const target of wanted) {
    const spec = TARGETS[target];
    if (!spec) {
      console.error(`unknown target ${target} (known: ${Object.keys(TARGETS).join(", ")})`);
      process.exit(1);
    }
    const dir = path.join(outRoot, target);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    if (spec.kind === "bun") {
      await buildBun(target, spec.bunTarget, dir);
    } else {
      await buildSea(dir);
    }
    const produced = (await fs.readdir(dir)).map((f) => path.join("dist-bin", target, f));
    console.log(`compiled ${target}: ${produced.join(", ")}`);
    // Dev convenience: keep bin/ (what a development checkout of the extension loads first) in sync with
    // the host build, so the extension host / IDE proofs never pick up a stale binary from an old package run.
    if (target === hostTarget()) {
      const binDir = path.join(root, "bin");
      await fs.rm(binDir, { recursive: true, force: true });
      await fs.mkdir(binDir, { recursive: true });
      for (const f of await fs.readdir(dir)) {
        await fs.copyFile(path.join(dir, f), path.join(binDir, f));
        if (!target.startsWith("win32")) {
          await fs.chmod(path.join(binDir, f), 0o755);
        }
      }
      console.log(`refreshed bin/ from dist-bin/${target}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
