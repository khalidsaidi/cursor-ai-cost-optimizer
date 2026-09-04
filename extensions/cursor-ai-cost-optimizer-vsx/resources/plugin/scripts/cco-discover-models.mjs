#!/usr/bin/env node
/**
 * Map CCO tiers (fast/balanced/deep) to models that this account can actually run,
 * then write .cursor/cco-runtime.json and workspace-level .cursor/agents/cco-*.md overrides
 * so each tier's subagent really executes on its model.
 *
 *   node scripts/cco-discover-models.mjs --workspace <root> [--probe|--no-probe] [--no-write-agents] [--json]
 */
import path from "node:path";
import {
  TIERS,
  nowIso,
  parseArgs,
  readJsonSafe,
  writeJson,
  workspacePaths,
  asNumber, isMain, applyScopeArgs } from "./lib/common.mjs";
applyScopeArgs();
import { loadConfig } from "./lib/config.mjs";
import { loadPricing, resolveModelPrice } from "./lib/pricing.mjs";
import {
  listModels,
  cliVersion,
  rankCandidates,
  probeModel,
  snapshotCliModel,
  restoreCliModel,
  currentCliModelId
} from "./lib/models.mjs";
import { writeWorkspaceAgents } from "./lib/agents.mjs";

function normalizeOverrides(config) {
  const raw = config?.modelOverrides || {};
  const out = {};
  for (const tier of TIERS) {
    out[tier] = typeof raw[tier] === "string" ? raw[tier].trim() : "";
  }
  return out;
}

export function discover({ workspace, probe, writeAgents, config: configOverride = null, models: modelsOverride = null, probeFn = probeModel }) {
  const paths = workspacePaths(workspace);
  const config = configOverride || loadConfig(workspace);
  const pricing = loadPricing(paths.pricingPath);
  let listing = modelsOverride || listModels();
  const notes = [];
  if (!listing.ok) {
    // No Cursor CLI (or not logged in): fall back to the bundled catalogue so tiers still get real models.
    const fallback = ["composer-2.5", "claude-sonnet-5-thinking-high", "claude-opus-5-thinking-high", "gpt-5.6-sol-high", "cursor-grok-4.6-high", "gemini-3.8-flash-high"].map((id) => ({ id, label: id, current: false, default: false }));
    notes.push(`Cursor CLI unavailable (${listing.error}); using the bundled model catalogue. Install the CLI (https://cursor.com/install) and re-run /cco-init to map from your account's real model list.`);
    listing = { ok: true, models: fallback, current: null, defaultModel: null, fallback: true };
  }
  // Probing runs through the CLI: with no usable CLI every probe would fail for reasons that have nothing to do
  // with the model, and the tiers would end up on "inherit" (no savings at all). Map unverified instead.
  if (probe && listing.fallback) {
    probe = false;
    notes.push("tier models were not verified on this account (no usable Cursor CLI); Cursor applies the account's own access rules when a subagent runs");
  }
  const available = listing.models || [];
  const availableSet = new Set(available.map((m) => m.id));
  const overrides = normalizeOverrides(config);
  const policy = config?.modelOverridePolicy === "strict" ? "strict" : "best_effort";
  const maxProbes = Math.max(1, asNumber(config?.discovery?.maxProbesPerTier, 2));

  const probes = {};
  const snapshot = probe ? snapshotCliModel() : null;
  // A failure that is about the CLI or the account, not the model: no further probe can succeed either.
  const CLI_LEVEL = new Set(["auth_required", "workspace_trust"]);
  const probeOnce = (id) => {
    if (!probe) {
      return { runnable: true, reason: "unprobed" };
    }
    if (!probes[id]) {
      let result = probeFn(id, workspace);
      // Transient failures (timeouts, execution errors during CLI updates or load) get one retry.
      if (!result.runnable && ["timeout", "execution_error"].includes(result.reason)) {
        const retry = probeFn(id, workspace);
        result = retry.runnable ? retry : { ...retry, retried: true };
      }
      probes[id] = result;
      if (!result.runnable && CLI_LEVEL.has(result.reason)) {
        probe = false;
        notes.push(`probing stopped (${result.reason}): tier models were not verified on this account; Cursor applies the account's own access rules when a subagent runs`);
      }
    }
    return probes[id];
  };

  const profiles = {};
  for (const tier of TIERS) {
    const ranked = rankCandidates({ tier, models: available, pricing, config });
    let chosen = null;
    let source = null;

    const requested = overrides[tier];
    if (requested) {
      if (!availableSet.has(requested)) {
        notes.push(`override ${tier}=${requested} ignored: not in \`cursor-agent models\` output`);
        if (policy === "strict") {
          chosen = null;
          source = "override_strict_unavailable";
        }
      } else {
        const result = probe ? probeOnce(requested) : null;
        if (result && result.runnable === false && !CLI_LEVEL.has(result.reason)) {
          notes.push(`override ${tier}=${requested} ignored: probe failed (${result.reason})`);
          if (policy === "strict") {
            source = "override_strict_probe_failed";
          }
        } else {
          chosen = { id: requested, label: available.find((m) => m.id === requested)?.label || requested };
          source = "user_override";
        }
      }
    }

    if (!chosen && !source?.startsWith("override_strict")) {
      let tried = 0;
      for (const candidate of ranked) {
        if (probe) {
          if (tried >= maxProbes) {
            break;
          }
          tried += 1;
          const result = probeOnce(candidate.id);
          // A CLI/account-level failure says nothing about this model: keep it, unverified.
          if (!result.runnable && !CLI_LEVEL.has(result.reason)) {
            continue;
          }
        }
        chosen = candidate;
        source = probe ? "ranked_probed" : "ranked_unprobed";
        break;
      }
      if (!chosen && !probe && ranked.length) {
        chosen = ranked[0];
        source = "ranked_unprobed";
      }
    }

    const model = chosen?.id || "inherit";
    const price = resolveModelPrice(model, pricing, { label: chosen?.label, overrides: config?.pricing?.overrides });
    if (!chosen) {
      notes.push(`no runnable candidate for ${tier}; subagent will inherit the session model`);
    }
    profiles[tier] = {
      model,
      label: chosen?.label || null,
      source: source || "fallback_inherit",
      price: Number.isFinite(price.input)
        ? { input: price.input, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite, output: price.output, row: price.matchedRow, confidence: price.confidence }
        : null,
      candidates: ranked.slice(0, 6).map((c) => ({ id: c.id, rank: c.rank, blendedRatePerMillion: c.blendedRatePerMillion })),
      probe: probes[model] || null
    };
  }

  let restore = null;
  if (probe) {
    restore = restoreCliModel(snapshot);
  }

  const verifierTier = TIERS.includes(config?.discovery?.verifierTier) ? config.discovery.verifierTier : "balanced";
  const verifierModel = profiles[verifierTier].model;
  const distinct = new Set(TIERS.map((tier) => profiles[tier].model).filter((m) => m !== "inherit"));
  if (distinct.size < 3) {
    notes.push(`only ${distinct.size} distinct model(s) mapped across tiers`);
  }

  const tierModels = {
    "cco-fast": profiles.fast.model,
    "cco-balanced": profiles.balanced.model,
    "cco-deep": profiles.deep.model,
    "cco-verifier": verifierModel,
    "cco-explore": profiles.fast.model
  };
  const agentWrites = writeAgents && workspace ? writeWorkspaceAgents(workspace, tierModels) : [];
  for (const write of agentWrites) {
    if (write.action === "skipped_user_file") {
      notes.push(`${path.basename(write.path)} is user-managed; not overwritten`);
    }
  }

  const runtime = {
    schemaVersion: 2,
    generatedAt: nowIso(),
    workspace,
    cli: {
      version: cliVersion(),
      currentModel: listing.current || null,
      defaultModel: listing.defaultModel || null,
      sessionModelFromCliConfig: currentCliModelId()
    },
    pricing: { loadedFrom: pricing.loadedFrom, fetchedAt: pricing.fetchedAt || null },
    discovery: {
      probed: Boolean(probe),
      availableModels: available.map((m) => m.id),
      probes,
      overrides: { requested: overrides, policy },
      restore
    },
    profiles,
    verifier: { tier: verifierTier, model: verifierModel },
    agents: agentWrites,
    health: { degraded: notes.length > 0, notes }
  };
  writeJson(paths.runtimePath, runtime);
  return runtime;
}

export function summarize(runtime) {
  return {
    runtimePath: workspacePaths(runtime.workspace).runtimePath,
    fast: runtime.profiles.fast.model,
    balanced: runtime.profiles.balanced.model,
    deep: runtime.profiles.deep.model,
    verifier: runtime.verifier.model,
    probed: runtime.discovery.probed,
    availableCount: runtime.discovery.availableModels.length,
    degraded: runtime.health.degraded,
    notes: runtime.health.notes,
    agents: runtime.agents.map((a) => `${a.name}: ${a.action}${a.model ? ` (${a.model})` : ""}`)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2), { workspace: process.cwd(), probe: null, "write-agents": null, json: false });
  const workspace = path.resolve(String(args.workspace));
  const config = loadConfig(workspace);
  const probe = args.probe === null ? config?.discovery?.probeOnInit !== false : Boolean(args.probe);
  const writeAgents = args["write-agents"] === null ? config?.discovery?.writeAgents !== false : Boolean(args["write-agents"]);
  const runtime = discover({ workspace, probe, writeAgents, config });
  console.log(JSON.stringify(args.json ? runtime : summarize(runtime), null, 2));

}

if (isMain(import.meta.url)) {
  main();
}
