#!/usr/bin/env node
/**
 * Prove the packaged VSIX installs on THIS platform: download the VS Code build for the host
 * (via @vscode/test-electron, same as the integration tests), install the .vsix with the real CLI
 * (`code --install-extension`), list it back with its version, then uninstall it.
 *
 *   node scripts/verify-vsix.mjs [--target <vscode-target>]   (default: host target)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import { hostTarget } from "./compile-binaries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const t = argv.indexOf("--target");
const target = t !== -1 ? argv[t + 1] : hostTarget();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const vsix = path.join(root, `${pkg.name}-${pkg.version}-${target}.vsix`);
if (!fs.existsSync(vsix)) {
  console.error(`missing ${vsix} (run: node scripts/package-extension.mjs --target ${target})`);
  process.exit(1);
}
const id = `${pkg.publisher}.${pkg.name}`;
const extDir = fs.mkdtempSync(path.join(root, ".vscode-test-ext-"));
const userDir = fs.mkdtempSync(path.join(root, ".vscode-test-user-"));
const exe = await downloadAndUnzipVSCode();
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
// the resolver adds its own --extensions-dir/--user-data-dir; use our throwaway dirs instead
const ownDirs = cliArgs.filter((a) => !/^--(extensions-dir|user-data-dir)=/.test(a));
const common = [...ownDirs, "--extensions-dir", extDir, "--user-data-dir", userDir];
function code(args) {
  const res = spawnSync(cli, [...common, ...args], { encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, DONT_PROMPT_WSL_INSTALL: "1" } });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}
try {
  const install = code(["--install-extension", vsix, "--force"]);
  console.log(install.out.trim());
  if (install.status !== 0) throw new Error(`install failed (${install.status})`);
  const list = code(["--list-extensions", "--show-versions"]);
  console.log(list.out.trim());
  if (!list.out.toLowerCase().includes(`${id.toLowerCase()}@${pkg.version}`)) throw new Error(`${id}@${pkg.version} not listed after install`);
  const manifest = path.join(extDir, `${id}-${pkg.version}`, "package.json");
  const installed = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : null;
  console.log(`installed ${id}@${installed?.version ?? "?"} (target ${target}) from ${path.basename(vsix)}`);
  if (target !== "universal") {
    const bin = path.join(extDir, `${id}-${pkg.version}`, "bin", target.startsWith("win32") ? "cco-hook.exe" : "cco-hook");
    if (!fs.existsSync(bin)) throw new Error(`hook binary missing inside the installed extension: ${bin}`);
    console.log(`hook binary present: ${path.relative(extDir, bin)}`);
  }
  const un = code(["--uninstall-extension", id]);
  console.log(un.out.trim());
  if (un.status !== 0) throw new Error(`uninstall failed (${un.status})`);
  console.log(`OK: ${path.basename(vsix)} installs, lists and uninstalls on ${hostTarget()}`);
} finally {
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
}
