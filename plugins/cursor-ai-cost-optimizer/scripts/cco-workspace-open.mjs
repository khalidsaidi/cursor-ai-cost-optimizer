#!/usr/bin/env node
/**
 * workspaceOpen hook (IDE app lifecycle; the IDE does not send a per-chat sessionStart).
 * Refreshes pricing and model discovery (no probes) and keeps .cursor/agents/cco-*.md in sync,
 * so tier models are in place before the first chat. Fail-open; emits {}.
 */
import fs from "node:fs";
import path from "node:path";
import { readStdin, safeJsonParse, workspaceFromPayload, workspacePaths, ensureDir, hookLog, emit, isEnabled, isMain, applyScopeArgs } from "./lib/common.mjs";
applyScopeArgs();
import { loadConfig } from "./lib/config.mjs";
import { refreshPricingIfStale, refreshDiscoveryIfStale } from "./cco-session-start.mjs";

async function main() {
  const payload = safeJsonParse((await readStdin()).trim() || "{}");
  const workspace = workspaceFromPayload(payload);
  if (!workspace) {
    emit({});
    return;
  }
  if (!isEnabled(workspace).enabled) {
    emit({});
    return;
  }
  const paths = workspacePaths(workspace);
  // User scope: nothing lives in the repo, so the rule, commands and skills are handed to Cursor as a plugin
  // path for this workspace (docs: workspaceOpen may return pluginPaths). Project scope has them in .cursor/.
  const output = paths.scope === "user" && paths.pluginDir && fs.existsSync(path.join(paths.pluginDir, ".cursor-plugin", "plugin.json")) ? { pluginPaths: [paths.pluginDir] } : {};
  try {
    ensureDir(paths.stateDir);
    const config = loadConfig(workspace);
    const pricing = await refreshPricingIfStale({ paths, config });
    const discovery = refreshDiscoveryIfStale({ workspace, paths, config });
    hookLog(paths, { event: "workspaceOpen", pricing, discovery, pluginPaths: output.pluginPaths || null });
  } catch (error) {
    hookLog(paths, { event: "workspaceOpen", error: String(error?.message || error) });
  }
  emit(output);
}

if (isMain(import.meta.url) || process.env.CCO_HOOK_MAIN === "cco-workspace-open.mjs") {
  main().catch(() => emit({}));
}
