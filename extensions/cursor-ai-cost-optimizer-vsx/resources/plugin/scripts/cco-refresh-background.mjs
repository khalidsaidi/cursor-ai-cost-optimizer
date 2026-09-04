#!/usr/bin/env node
/**
 * Internal `refresh` event: the detached worker that sessionStart/workspaceOpen schedule when the price table
 * or the model map is stale. Runs the refreshes synchronously (network + CLI startup allowed here, nothing is
 * waiting on us), then clears the scheduling lock. Fail-open; emits {}.
 *
 *   cco-hook refresh [--scope user --state-root <dir>] --workspace <root>
 */
import fs from "node:fs";
import path from "node:path";
import { readStdin, safeJsonParse, workspaceFromPayload, workspacePaths, ensureDir, hookLog, emit, isEnabled, isMain, applyScopeArgs } from "./lib/common.mjs";
applyScopeArgs();
import { loadConfig } from "./lib/config.mjs";
import { refreshPricingIfStale, refreshDiscoveryIfStale } from "./cco-session-start.mjs";

async function main() {
  const payload = process.env.CCO_WORKSPACE ? {} : safeJsonParse((await readStdin()).trim() || "{}");
  const workspace = workspaceFromPayload(payload);
  if (!workspace || !isEnabled(workspace).enabled) {
    emit({});
    return;
  }
  const paths = workspacePaths(workspace);
  const lock = path.join(path.dirname(paths.pricingPath), "refresh.lock");
  try {
    ensureDir(paths.stateDir);
    const config = loadConfig(workspace);
    const pricing = await refreshPricingIfStale({ paths, config });
    const discovery = refreshDiscoveryIfStale({ workspace, paths, config });
    hookLog(paths, { event: "refresh", pricing, discovery });
  } catch (error) {
    hookLog(paths, { event: "refresh", error: String(error?.message || error) });
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {}
  }
  emit({});
}

if (isMain(import.meta.url) || process.env.CCO_HOOK_MAIN === "cco-refresh-background.mjs") {
  main().catch(() => emit({}));
}
