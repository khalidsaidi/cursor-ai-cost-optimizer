// The knobs a user is expected to touch live in Cursor's Settings UI (user scope = every project, workspace
// scope = this project), like the first-party extensions. They are mirrored into the plugin's config files,
// which the hooks read on every call: <stateRoot>/cco.json for user-level values, <ws>/.cursor/cco.json for
// values set at workspace level (and only then, so no repo file appears unasked).
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { mergeConfigFile, settingsToPluginConfig, type RoutingSettings } from "./settingsCore";
export { ROUTING_SETTING_KEYS, mergeConfigFile, settingsToPluginConfig, type RoutingSettings } from "./settingsCore";

function valuesFrom(cfg: vscode.WorkspaceConfiguration, level: "global" | "workspace"): { values: RoutingSettings; anySet: boolean } {
  let anySet = false;
  const pick = <T,>(key: string, fallback: T): T => {
    const info = cfg.inspect<T>(key);
    const v = level === "workspace" ? info?.workspaceValue ?? info?.workspaceFolderValue : info?.globalValue;
    if (v !== undefined) {
      anySet = true;
      return v;
    }
    return level === "global" ? (info?.defaultValue ?? fallback) : fallback;
  };
  const values: RoutingSettings = {
    tierModels: { fast: pick("tierModels.fast", ""), balanced: pick("tierModels.balanced", ""), deep: pick("tierModels.deep", "") },
    enforceRouting: pick("enforceRouting", false),
    alwaysDelegate: pick("alwaysDelegate", false),
    chatBudgetUsd: pick("chatBudgetUsd", 0),
    modelCooldownHours: pick("modelCooldownHours", 6),
  };
  return { values, anySet };
}

/**
 * Mirror the settings into the plugin config files. User-level values always go to the state root; workspace-level
 * values go to the project's .cursor/cco.json only when the user set one at that level.
 */
export function syncSettingsToPluginConfig(stateRoot: string, workspace: string | null): { tierModelsChanged: boolean } {
  const cfg = vscode.workspace.getConfiguration("cco");
  let tierModelsChanged = false;
  const global = valuesFrom(cfg, "global");
  tierModelsChanged = mergeConfigFile(path.join(stateRoot, "cco.json"), settingsToPluginConfig(global.values)).tierModelsChanged || tierModelsChanged;
  if (workspace) {
    const ws = valuesFrom(cfg, "workspace");
    const file = path.join(workspace, ".cursor", "cco.json");
    if (ws.anySet || fs.existsSync(file)) {
      // Workspace-level values override; unset ones fall back to the user-level values (not the defaults).
      const merged: RoutingSettings = {
        tierModels: { ...global.values.tierModels },
        enforceRouting: global.values.enforceRouting,
        alwaysDelegate: global.values.alwaysDelegate,
        chatBudgetUsd: global.values.chatBudgetUsd,
        modelCooldownHours: global.values.modelCooldownHours,
      };
      const inspectSet = (key: string) => {
        const info = cfg.inspect(key);
        return info?.workspaceValue !== undefined || info?.workspaceFolderValue !== undefined;
      };
      if (inspectSet("tierModels.fast")) merged.tierModels.fast = ws.values.tierModels.fast;
      if (inspectSet("tierModels.balanced")) merged.tierModels.balanced = ws.values.tierModels.balanced;
      if (inspectSet("tierModels.deep")) merged.tierModels.deep = ws.values.tierModels.deep;
      if (inspectSet("enforceRouting")) merged.enforceRouting = ws.values.enforceRouting;
      if (inspectSet("alwaysDelegate")) merged.alwaysDelegate = ws.values.alwaysDelegate;
      if (inspectSet("chatBudgetUsd")) merged.chatBudgetUsd = ws.values.chatBudgetUsd;
      if (inspectSet("modelCooldownHours")) merged.modelCooldownHours = ws.values.modelCooldownHours;
      if (ws.anySet) {
        tierModelsChanged = mergeConfigFile(file, settingsToPluginConfig(merged)).tierModelsChanged || tierModelsChanged;
      }
    }
  }
  return { tierModelsChanged };
}
