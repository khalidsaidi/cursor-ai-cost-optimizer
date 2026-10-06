// Pure settings mapping (no vscode import) so it can be unit-tested outside the extension host.
import * as fs from "node:fs";
import * as path from "node:path";

export interface RoutingSettings {
  tierModels: { fast: string; balanced: string; deep: string };
  enforceRouting: boolean;
  alwaysDelegate: boolean;
  chatBudgetUsd: number;
  modelCooldownHours: number;
}

export const ROUTING_SETTING_KEYS = ["tierModels.fast", "tierModels.balanced", "tierModels.deep", "enforceRouting", "alwaysDelegate", "chatBudgetUsd", "modelCooldownHours"] as const;

/** Plugin config fragment for a set of settings values. Pure; unit-tested. */
export function settingsToPluginConfig(s: RoutingSettings): Record<string, unknown> {
  return {
    modelOverrides: { fast: s.tierModels.fast.trim(), balanced: s.tierModels.balanced.trim(), deep: s.tierModels.deep.trim() },
    modelOverridePolicy: "best_effort",
    enforcement: { mode: s.enforceRouting ? "strict" : "advise", requireDelegation: s.alwaysDelegate ? "always" : "auto" },
    learning: { limitCooldownMinutes: Math.max(1, Math.round(s.modelCooldownHours * 60)) },
    budget: { sessionUsd: Math.max(0, Number(s.chatBudgetUsd) || 0) },
  };
}

/** Merge a fragment into an existing config file, keeping keys the fragment does not mention. */
export function mergeConfigFile(file: string, fragment: Record<string, unknown>): { changed: boolean; tierModelsChanged: boolean } {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(fragment)) {
    const prev = existing[key];
    merged[key] = value && typeof value === "object" && !Array.isArray(value) && prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>), ...(value as Record<string, unknown>) } : value;
  }
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) {
    return { changed: false, tierModelsChanged: false };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  const tierModelsChanged = JSON.stringify((existing.modelOverrides) ?? null) !== JSON.stringify(merged.modelOverrides);
  return { changed: true, tierModelsChanged };
}

