#!/usr/bin/env node
/**
 * sessionStart hook:
 *  1. refresh the price table from Cursor docs when stale (best effort),
 *  2. refresh model discovery (no probes) when stale, and keep workspace cco-* agents in sync,
 *  3. inject a short CCO context block (tier→model mapping + prices) into the session.
 * Always exits 0 and always emits {continue:true}; every step is fail-open.
 */
import {
  readStdin,
  safeJsonParse,
  workspaceFromPayload,
  workspacePaths,
  readJsonSafe,
  writeJson,
  ensureDir,
  isEnabled,
  ageHours,
  hookLog,
  emit,
  nowIso,
  asNumber, isMain, applyScopeArgs, scopeArgs } from "./lib/common.mjs";
applyScopeArgs();
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.mjs";
import { refreshPricing } from "./cco-refresh-pricing.mjs";
import { discover } from "./cco-discover-models.mjs";
import { buildSessionContext } from "./lib/context.mjs";
import { cliVersion } from "./lib/models.mjs";
import { createSession, pruneSessions, normalizeModelId } from "./lib/session.mjs";
import { writeWorkspaceAgents, workspaceHasAgents } from "./lib/agents.mjs";
import { TIERS } from "./lib/common.mjs";

const REFRESH_LOCK_MINUTES = 10;

function refreshLockPath(paths) {
  return path.join(path.dirname(paths.pricingPath), "refresh.lock");
}

/**
 * Chat-start hooks must never wait on the network or on CLI startup: when the price table or the model map is
 * stale, a detached `cco-hook refresh` process (same runtime: node + dispatcher, or the compiled binary) does
 * the work and the current session keeps the cached data. A lock file keeps concurrent sessions from starting
 * more than one refresh per REFRESH_LOCK_MINUTES.
 */
export function scheduleBackgroundRefresh({ workspace, paths }) {
  const lock = refreshLockPath(paths);
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < REFRESH_LOCK_MINUTES * 60_000) {
      return { action: "scheduled", already: true };
    }
  } catch {}
  try {
    ensureDir(path.dirname(lock));
    fs.writeFileSync(lock, nowIso(), "utf8");
    const bundled = Boolean(process.env.CCO_HOOK_MAIN);
    const argv = bundled ? [] : [path.join(path.dirname(fileURLToPath(import.meta.url)), "cco-hook.mjs")];
    argv.push("refresh", ...scopeArgs(), "--workspace", workspace);
    const child = spawn(process.execPath, argv, { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
    child.on("error", () => {});
    child.unref();
    return { action: "scheduled", pid: child.pid ?? null };
  } catch (error) {
    return { action: "failed", error: String(error?.message || error).slice(0, 200) };
  }
}

export async function refreshPricingIfStale({ paths, config, background = false, workspace = null }) {
  const pricingCfg = config?.pricing || {};
  if (pricingCfg.enabled === false) {
    return { action: "disabled" };
  }
  const refreshHours = asNumber(process.env.CCO_PRICING_REFRESH_HOURS ?? pricingCfg.refreshHours, 24);
  const existing = readJsonSafe(paths.pricingPath);
  const age = ageHours(existing?.fetchedAt);
  if (existing && Array.isArray(existing.models) && existing.models.length >= 10 && age < refreshHours) {
    return { action: "cached", ageHours: Number(age.toFixed(2)) };
  }
  if (background) {
    return { ...scheduleBackgroundRefresh({ workspace, paths }), ageHours: Number.isFinite(age) ? Number(age.toFixed(2)) : null };
  }
  try {
    const payload = await refreshPricing({ sourceUrl: pricingCfg.sourceUrl });
    writeJson(paths.pricingPath, payload);
    return { action: "refreshed", rows: payload.models.length };
  } catch (error) {
    return { action: "failed", error: String(error?.message || error).slice(0, 300), keptExisting: Boolean(existing) };
  }
}

export function refreshDiscoveryIfStale({ workspace, paths, config, background = false }) {
  const discoveryCfg = config?.discovery || {};
  if (discoveryCfg.auto === false) {
    return { action: "disabled" };
  }
  const refreshHours = asNumber(discoveryCfg.refreshHours, 24);
  const existing = readJsonSafe(paths.runtimePath);
  const age = ageHours(existing?.generatedAt);
  const version = cliVersion();
  const versionChanged = existing?.cli?.version && version && existing.cli.version !== version;
  if (existing && existing.schemaVersion === 2 && age < refreshHours && !versionChanged) {
    // Runtime is fresh; still make sure the plugin's tier agents match it (a plugin update resets them).
    let agents = [];
    if (discoveryCfg.writeAgents !== false && existing.profiles && workspaceHasAgents(workspace)) {
      const verifierTier = TIERS.includes(existing.verifier?.tier) ? existing.verifier.tier : "balanced";
      agents = writeWorkspaceAgents(workspace, {
        "cco-fast": existing.profiles.fast?.model || "inherit",
        "cco-balanced": existing.profiles.balanced?.model || "inherit",
        "cco-deep": existing.profiles.deep?.model || "inherit",
        "cco-verifier": existing.verifier?.model || existing.profiles[verifierTier]?.model || "inherit",
        "cco-explore": existing.profiles.fast?.model || "inherit"
      }).filter((a) => a.action === "written").map((a) => a.name);
    }
    return { action: "cached", ageHours: Number(age.toFixed(2)), agentsWritten: agents };
  }
  if (background && existing && existing.schemaVersion === 2) {
    // A stale-but-usable map serves this session; the detached refresh replaces it for the next one.
    return scheduleBackgroundRefresh({ workspace, paths });
  }
  try {
    const runtime = discover({
      workspace,
      probe: false,
      writeAgents: discoveryCfg.writeAgents !== false && workspaceHasAgents(workspace),
      config
    });
    return {
      action: existing ? "refreshed" : "initialized",
      fast: runtime.profiles.fast.model,
      balanced: runtime.profiles.balanced.model,
      deep: runtime.profiles.deep.model,
      degraded: runtime.health.degraded
    };
  } catch (error) {
    return { action: "failed", error: String(error?.message || error).slice(0, 300) };
  }
}

async function main() {
  const payload = safeJsonParse((await readStdin()).trim() || "{}");
  const workspace = workspaceFromPayload(payload);
  if (!workspace) {
    emit({ continue: true, cco: "no workspace root in payload" });
    return;
  }
  const enabled = isEnabled(workspace);
  if (!enabled.enabled) {
    const output = { continue: true, cco: enabled.reason };
    if (enabled.reason === "workspace_opt_out") {
      // The rule and cco-* subagents are still loaded; tell the session to work as if CCO were not there.
      output.additional_context = "AI Cost Optimizer is paused in this project: work normally in this chat, do not delegate to cco-* subagents, and do not add a [cco: …] footer.";
    }
    emit(output);
    return;
  }
  const paths = workspacePaths(workspace);
  ensureDir(paths.stateDir);
  const config = loadConfig(workspace);

  const pricing = await refreshPricingIfStale({ paths, config, background: true, workspace });
  const discovery = refreshDiscoveryIfStale({ workspace, paths, config, background: true });
  const sessionModel = payload.model ? normalizeModelId(payload.model) : null;
  let sessionState = { created: false };
  try {
    pruneSessions(workspace);
    if (payload.conversation_id) {
      createSession({ workspace, conversationId: payload.conversation_id, model: sessionModel, payload });
      sessionState = { created: true };
    }
  } catch (error) {
    sessionState = { created: false, error: String(error?.message || error) };
  }
  let additionalContext = "";
  try {
    additionalContext = buildSessionContext({ workspace, config, sessionModel });
  } catch (error) {
    additionalContext = "";
    hookLog(paths, { event: "sessionStart", contextError: String(error?.message || error) });
  }

  hookLog(paths, {
    event: "sessionStart",
    conversation_id: payload.conversation_id ?? null,
    model: sessionModel,
    pricing,
    discovery,
    session: sessionState
  });

  const justWritten = discovery.action === "initialized" || (Array.isArray(discovery.agentsWritten) && discovery.agentsWritten.length > 0);
  if (additionalContext && justWritten) {
    additionalContext += "\nNote: tier models were just (re)mapped; Cursor loads subagents at chat start, so they may only apply from the next chat.";
  }
  const output = { continue: true, cco: { pricing: pricing.action, discovery: discovery.action, at: nowIso() } };
  if (additionalContext) {
    output.additional_context = additionalContext;
  }
  emit(output);
}

if (isMain(import.meta.url) || process.env.CCO_HOOK_MAIN === "cco-session-start.mjs") {
  main().catch((error) => {
    emit({ continue: true, cco: { error: String(error?.message || error) } });
  });
}
