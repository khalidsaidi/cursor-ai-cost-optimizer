#!/usr/bin/env node
/**
 * Set up CCO for a project. Everything goes under <project>/.cursor/ (Cursor's own convention):
 *   .cursor/hooks.json (merge-preserving), .cursor/agents/cco-*.md, .cursor/cco.json, .cursor/cco/
 *
 *   node scripts/cco-init.mjs --workspace . [--no-probe]
 *   node scripts/cco-init.mjs --workspace . --disable | --enable | --uninstall
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs, workspacePaths, writeJson, readJsonSafe, TIERS, CCO_AGENT_NAMES, isMain } from "./lib/common.mjs";
import { loadConfig } from "./lib/config.mjs";
import { refreshPricing } from "./cco-refresh-pricing.mjs";
import { discover } from "./cco-discover-models.mjs";
import { installHooks, uninstallHooks } from "./cco-install-hooks.mjs";
import { resolveModelPrice, loadPricing } from "./lib/pricing.mjs";
import { GENERATED_MARKER } from "./lib/agents.mjs";

function setEnabled(workspace, on) {
  const paths = workspacePaths(workspace);
  const cfg = readJsonSafe(paths.configPath) || {};
  writeJson(paths.configPath, { ...cfg, enabled: on });
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { workspace: process.cwd(), probe: false, json: false, disable: false, enable: false, uninstall: false });
  const workspace = path.resolve(String(args.workspace));
  const paths = workspacePaths(workspace);

  if (args.uninstall) {
    const hooks = uninstallHooks({ workspace });
    const removed = [];
    for (const name of CCO_AGENT_NAMES) {
      const file = path.join(paths.agentsDir, `${name}.md`);
      try {
        if (fs.readFileSync(file, "utf8").includes(GENERATED_MARKER)) {
          fs.unlinkSync(file);
          removed.push(file);
        }
      } catch {}
    }
    fs.rmSync(paths.ccoDir, { recursive: true, force: true });
    for (const file of [paths.configPath, paths.shimPath]) {
      try {
        fs.unlinkSync(file);
        removed.push(file);
      } catch {}
    }
    console.log(JSON.stringify({ ok: true, uninstalled: true, workspace, hooks: hooks.file, removed: [...removed, paths.ccoDir] }, null, 2));
    return;
  }
  if (args.disable || args.enable) {
    setEnabled(workspace, Boolean(args.enable));
    console.log(JSON.stringify({ ok: true, workspace, enabled: Boolean(args.enable) }, null, 2));
    return;
  }

  const config = { path: paths.configPath, created: false }; // created lazily by /cco-models, --disable, or the user
  let pricing = { action: "skipped" };
  try {
    writeJson(paths.pricingPath, await refreshPricing({}));
    pricing = { action: "refreshed" };
  } catch (error) {
    pricing = { action: "bundled_fallback", error: String(error?.message || error).slice(0, 120) };
  }
  const hooks = installHooks({ workspace });
  const runtime = discover({ workspace, probe: Boolean(args.probe), writeAgents: true, config: loadConfig(workspace) });
  // The state folder ignores itself so nothing new shows up in git status (no edit to the user's .gitignore).
  try {
    fs.writeFileSync(path.join(paths.ccoDir, ".gitignore"), "*\n", "utf8");
  } catch {}
  const table = loadPricing(paths.pricingPath);
  const tiers = Object.fromEntries(
    TIERS.map((tier) => {
      const model = runtime.profiles[tier].model;
      const price = resolveModelPrice(model, table);
      return [tier, { model, pricePerMillion: Number.isFinite(price.input) ? `$${price.input} in / $${price.output} out` : "n/a" }];
    })
  );
  const summary = {
    ok: true,
    workspace,
    wrote: { hooks: hooks.file, shim: paths.shimPath, agents: paths.agentsDir, state: paths.ccoDir },
    pricing: pricing.action,
    tiers,
    degraded: runtime.health.degraded,
    notes: runtime.health.notes,
    next: "Start a new chat in Cursor. Keep your usual model; each routed task shows a CCO line."
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const rel = (p) => path.relative(workspace, p) || ".";
  const lines = [
    "AI Cost Optimizer is set up for this project.",
    "",
    `  FAST      → ${tiers.fast.model}  (${tiers.fast.pricePerMillion})`,
    `  BALANCED  → ${tiers.balanced.model}  (${tiers.balanced.pricePerMillion})`,
    `  DEEP      → ${tiers.deep.model}  (${tiers.deep.pricePerMillion})`,
    "",
    `Files (all inside ${rel(paths.cursorDir)}/): hooks.json + cco-hook.mjs (commit together; a no-op for teammates without the plugin), agents/cco-*.md, cco/ (state; ignores itself in git). Settings live in cco.json only if you create one (/cco-models writes it).`
  ];
  if (runtime.health.notes.length) {
    lines.push("", `Notes: ${runtime.health.notes.join("; ")}`);
  }
  lines.push("", "Next: start a new chat and work normally. Force a tier with [cco:fast] / [cco:deep]; turn off with /cco-off.");
  console.log(lines.join("\n"));
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error?.stack || error));
    process.exit(1);
  });
}
