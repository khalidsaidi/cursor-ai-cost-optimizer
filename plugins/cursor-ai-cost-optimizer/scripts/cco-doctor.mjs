#!/usr/bin/env node
/**
 * Health check for a project: node, hooks, agents, mapping, recent activity. Prints a short report.
 *   node scripts/cco-doctor.mjs --workspace .
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs, workspacePaths, readJsonSafe, readJsonl, ageHours, TIERS, CCO_AGENT_NAMES, isEnabled, isMain, applyScopeArgs } from "./lib/common.mjs";
applyScopeArgs();
import { readWorkspaceAgentModel } from "./lib/agents.mjs";
import { run, cursorAgentBinary } from "./lib/common.mjs";

export function diagnose(workspace) {
  const paths = workspacePaths(workspace);
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js 18+", ok: nodeMajor >= 18, detail: `node ${process.versions.node}` });
  const hooks = readJsonSafe(paths.hooksPath);
  const ours = hooks && Object.values(hooks.hooks || {}).some((list) => (list || []).some((e) => String(e.command || "").includes("cco-hook")));
  checks.push({ name: "Hooks installed (.cursor/hooks.json)", ok: Boolean(ours), detail: ours ? `${Object.keys(hooks.hooks).length} events` : "run /cco-init" });
  checks.push({ name: "Hook shim present (.cursor/cco-hook.mjs)", ok: fs.existsSync(paths.shimPath), detail: paths.shimPath });
  const agents = CCO_AGENT_NAMES.map((n) => ({ n, m: readWorkspaceAgentModel(workspace, n) }));
  const missing = agents.filter((a) => !a.m).map((a) => a.n);
  const unmapped = agents.filter((a) => a.m === "inherit").map((a) => a.n);
  checks.push({ name: "Tier agents present", ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : agents.map((a) => `${a.n}=${a.m}`).join(", ") });
  checks.push({ name: "Tier agents mapped to real models", ok: unmapped.length === 0, detail: unmapped.length ? `inherit: ${unmapped.join(", ")} (run /cco-models)` : "ok" });
  const runtime = readJsonSafe(paths.runtimePath);
  checks.push({ name: "Model mapping fresh (< 7 days)", ok: Boolean(runtime) && ageHours(runtime.generatedAt) < 24 * 7, detail: runtime ? `${ageHours(runtime.generatedAt).toFixed(1)} h old, CLI ${runtime.cli?.version || "?"}` : "no runtime.json" });
  const pricing = readJsonSafe(paths.pricingPath);
  checks.push({ name: "Price table cached", ok: Boolean(pricing?.models?.length), detail: pricing ? `${pricing.models.length} models, ${ageHours(pricing.fetchedAt).toFixed(1)} h old` : "missing" });
  const enabled = isEnabled(workspace);
  checks.push({ name: "Enabled for this project", ok: enabled.enabled, detail: enabled.reason || "yes" });
  const cli = run(cursorAgentBinary(), ["--version"], { timeout: 10_000 });
  checks.push({ name: "Cursor CLI available (for model discovery)", ok: !cli.error && cli.status === 0, detail: cli.error ? "not found — install with: curl https://cursor.com/install -fsS | bash (then `cursor-agent login`); until then CCO uses the bundled model catalogue" : String(cli.stdout || "").trim() });
  const decisions = readJsonl(paths.decisionsPath);
  const hooksLog = readJsonl(paths.hooksLogPath);
  checks.push({ name: "Recent activity", ok: true, detail: `${decisions.length} routing decision(s), ${hooksLog.length} hook event(s) logged` });
  return { workspace, ok: checks.every((c) => c.ok || c.name === "Recent activity"), checks };
}

export function renderDiagnosis(d) {
  const lines = [`# CCO doctor — ${path.basename(d.workspace)}`, ""];
  for (const c of d.checks) {
    lines.push(`- ${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
  }
  lines.push("", d.ok ? "All good. Start a new chat and work normally." : "Fix the ❌ items (most are solved by running /cco-init in this project).");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2), { workspace: process.cwd(), json: false });
  const d = diagnose(path.resolve(String(args.workspace)));
  console.log(args.json ? JSON.stringify(d, null, 2) : renderDiagnosis(d));
  process.exitCode = d.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main();
}
