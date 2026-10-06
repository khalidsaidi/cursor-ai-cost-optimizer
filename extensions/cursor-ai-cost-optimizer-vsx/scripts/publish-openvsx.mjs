#!/usr/bin/env node
/**
 * Publish the platform-targeted VSIXs to Open VSX (Cursor's extension registry).
 * Each target carries its own self-contained hook binary.
 *
 *   OVSX_TOKEN=... node scripts/publish-openvsx.mjs                  # package + publish all targets
 *   OVSX_TOKEN=... node scripts/publish-openvsx.mjs --targets linux-x64,win32-x64
 *   OVSX_TOKEN=... node scripts/publish-openvsx.mjs --skip-package   # publish existing .vsix files only
 *   node scripts/publish-openvsx.mjs --dry-run                       # print the commands, publish nothing
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS } from "./compile-binaries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const skipPackage = argv.includes("--skip-package");
const targetsFlag = argv.indexOf("--targets");
const targets = targetsFlag !== -1 ? argv[targetsFlag + 1].split(",").map((s) => s.trim()).filter(Boolean) : Object.keys(TARGETS);

const token = process.env.OVSX_TOKEN;
if (!token && !dryRun) {
  console.error("Missing OVSX_TOKEN env var.");
  process.exit(1);
}

function run(cmd, args, { redact = null } = {}) {
  const shown = redact ? args.map((a) => (a === redact ? "***" : a)) : args;
  console.log(`$ ${cmd} ${shown.join(" ")}`);
  if (dryRun) {
    return;
  }
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
  if (res.status !== 0) {
    console.error(`command failed: ${cmd} ${shown.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

for (const target of targets) {
  if (!TARGETS[target]) {
    console.error(`unknown target ${target}`);
    process.exit(1);
  }
  const vsix = `${pkg.name}-${pkg.version}-${target}.vsix`;
  if (!skipPackage || !existsSync(path.join(root, vsix))) {
    run(process.execPath, [path.join(root, "scripts", "package-extension.mjs"), "--target", target]);
  }
  run("npx", ["--yes", "ovsx", "publish", vsix, "--target", target, "-p", token ?? "<OVSX_TOKEN>"], { redact: token });
}
