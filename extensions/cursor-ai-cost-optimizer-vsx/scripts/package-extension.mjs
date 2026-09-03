#!/usr/bin/env node
/**
 * Package a platform-targeted VSIX that carries the self-contained hook binary for exactly that
 * platform (bin/cco-hook[.exe]); the install command falls back to `node .cursor/cco/scripts/cco-hook.mjs`
 * when no binary is bundled.
 *
 *   node scripts/package-extension.mjs                       # host platform
 *   node scripts/package-extension.mjs --target win32-x64    # one explicit target
 *   node scripts/package-extension.mjs --all                 # every target (compiles all first)
 *   node scripts/package-extension.mjs --skip-compile        # reuse dist-bin/ as is
 *   node scripts/package-extension.mjs --no-binaries         # universal VSIX without bin/ (node fallback only)
 *
 * Produces cursor-ai-cost-optimizer-<version>-<target>.vsix (or -universal.vsix).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, hostTarget } from "./compile-binaries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const binDir = path.join(root, "bin");

function run(cmd, args, cwd = root) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd, shell: process.platform === "win32" });
  if (res.status !== 0) {
    console.error(`command failed: ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

const argv = process.argv.slice(2);
// A previous run that crashed mid-packaging leaves package.json.orig behind: put the real manifest back first.
{
  const orig = path.join(root, "package.json.orig");
  if (existsSync(orig)) {
    writeFileSync(path.join(root, "package.json"), readFileSync(orig, "utf8"), "utf8");
    unlinkSync(orig);
    console.log("restored package.json from package.json.orig (previous packaging run did not finish)");
  }
}
const all = argv.includes("--all");
const skipCompile = argv.includes("--skip-compile");
const noBinaries = argv.includes("--no-binaries");
const targetFlag = argv.indexOf("--target");
const targets = noBinaries ? ["universal"] : all ? Object.keys(TARGETS) : [targetFlag !== -1 ? argv[targetFlag + 1] : hostTarget()];

run("npm", ["run", "compile"]);
const produced = [];
for (const target of targets) {
  await fs.rm(binDir, { recursive: true, force: true });
  const out = `${pkg.name}-${pkg.version}-${target}.vsix`;
  const vsceArgs = ["--yes", "@vscode/vsce", "package", "--out", out];
  if (target !== "universal") {
    if (!TARGETS[target]) {
      console.error(`unknown target ${target}`);
      process.exit(1);
    }
    const compiled = path.join(root, "dist-bin", target);
    // Always compile fresh unless told otherwise: a stale dist-bin must never ship.
    if (!skipCompile || !existsSync(compiled)) {
      run(process.execPath, [path.join(root, "scripts", "compile-binaries.mjs"), "--target", target]);
    }
    await fs.mkdir(binDir, { recursive: true });
    for (const entry of await fs.readdir(compiled)) {
      await fs.copyFile(path.join(compiled, entry), path.join(binDir, entry));
      if (!target.startsWith("win32")) {
        await fs.chmod(path.join(binDir, entry), 0o755);
      }
    }
    vsceArgs.push("--target", target);
  }
  // Ship a lean manifest (Copilot's applyPackageJsonPatch pattern): no dev scripts, no devDependencies.
  // The original is kept in package.json.orig and restored on every exit path (finally, process exit, and at
  // the start of the next run if a previous one crashed), so the repository manifest can never be left lean.
  const manifestPath = path.join(root, "package.json");
  const backupPath = path.join(root, "package.json.orig");
  const original = await fs.readFile(manifestPath, "utf8");
  await fs.writeFile(backupPath, original, "utf8");
  const restore = () => {
    try {
      writeFileSync(manifestPath, readFileSync(backupPath, "utf8"), "utf8");
      unlinkSync(backupPath);
    } catch {}
  };
  process.on("exit", restore);
  const shipped = JSON.parse(original);
  shipped.scripts = shipped.scripts && shipped.scripts["vscode:uninstall"] ? { "vscode:uninstall": shipped.scripts["vscode:uninstall"] } : undefined;
  delete shipped.devDependencies;
  await fs.writeFile(manifestPath, JSON.stringify(shipped, null, 2) + "\n", "utf8");
  try {
    run("npx", vsceArgs);
  } finally {
    restore();
    process.off("exit", restore);
  }
  const size = (await fs.stat(path.join(root, out))).size;
  produced.push({ target, out, size });
  console.log(`packaged ${out} (${(size / 1024 / 1024).toFixed(2)} MB)`);
}
console.log(JSON.stringify(produced, null, 2));
