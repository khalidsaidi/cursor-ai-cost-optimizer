import path from "node:path";
import { PLUGIN_ROOT, readJsonSafe, writeJson, workspacePaths } from "./common.mjs";

export const DEFAULTS_PATH = path.join(PLUGIN_ROOT, "config", "defaults.json");

export function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    return { ...override };
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = deepMerge(base[key] || {}, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function loadDefaults() {
  return readJsonSafe(DEFAULTS_PATH) || {};
}

/** Defaults merged with the project's .cursor/cco.json (if any). */
export function loadConfig(workspace) {
  const defaults = loadDefaults();
  const user = workspace ? readJsonSafe(workspacePaths(workspace).configPath) : null;
  if (!user) {
    return { ...defaults, _source: "defaults" };
  }
  return { ...deepMerge(defaults, user), _source: "workspace" };
}

/** Write the project's config with only the knobs people are expected to touch. */
export function ensureWorkspaceConfig(workspace) {
  const configPath = workspacePaths(workspace).configPath;
  const existing = readJsonSafe(configPath);
  if (existing) {
    return { created: false, path: configPath };
  }
  const defaults = loadDefaults();
  writeJson(configPath, {
    version: defaults.version,
    enabled: true,
    modelOverrides: { fast: "", balanced: "", deep: "" },
    modelOverridePolicy: "best_effort",
    pricing: { plan: "pro" },
    thresholds: defaults.thresholds,
    guardrails: defaults.guardrails,
    enforcement: { requireDelegation: "auto" }
  });
  return { created: true, path: configPath };
}
