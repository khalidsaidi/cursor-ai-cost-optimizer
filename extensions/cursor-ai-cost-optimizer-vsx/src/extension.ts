import * as vscode from "vscode";
import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decideHookMode, doctorWorkspace, findBundledBinary, findNode, installWorkspace, plannedFiles, runPluginScriptAsync, stripCcoHooks, uninstallWorkspace, workspacePaths, workspaceStatus, type HookRuntimePreference, type HooksFile, type Options } from "./install";
import { costStatement, formatUsd, readSavings, readLastDecision, readTierModels, loadPricing, modelDisplayName } from "./pricing";
import { syncSettingsToPluginConfig } from "./settings";
import { hooksLoadedInWindow } from "./hooksLog";
import { doctorUser, installUser, pauseWorkspace, stripUserHooks, uninstallUser, userHookCommand, userStatus, workspacePaused, workspaceStateDir } from "./userScope";
import { runHookCommand } from "./selfcheck";
import { decideTier, heuristicScores, overrideToken, parseOverride, DEFAULT_CONFIG } from "./scorer";

const RUNTIME_REL = ".cursor/cco/runtime.json";
const EXTENSION_ID = "khalidsaidi.cursor-ai-cost-optimizer";
const MIGRATION_WARNED_KEY = "cco.settingsMigrationWarned";
const REMOVED_SETTINGS = ["cco.budgetPressure", "cco.economyMode"];

let log: vscode.LogOutputChannel;

/** AWS `showViewLogsMessage` pattern: every user-facing message can open the log channel. */
async function notify(kind: "info" | "warn" | "error", message: string, extraItems: string[] = [], options: vscode.MessageOptions = {}): Promise<string | undefined> {
  const logsItem = "View Logs";
  const items = [...extraItems, logsItem];
  const show = kind === "error" ? vscode.window.showErrorMessage : kind === "warn" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  if (kind === "error") {
    log.error(message);
  } else if (kind === "warn") {
    log.warn(message);
  }
  const choice = await show(message, options, ...items);
  if (choice === logsItem) {
    log.show(true);
  }
  return choice;
}

function firstWorkspace(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

interface Settings {
  hookRuntime: HookRuntimePreference;
  nodePath: string | null;
}
/** Feedback for an action the user just took: 4 s in the status bar, never a popup. */
function flash(text: string): void {
  vscode.window.setStatusBarMessage(`$(zap) ${text}`, 4000);
}

function settings(): Settings {
  const cfg = vscode.workspace.getConfiguration("cco");
  return {
    hookRuntime: cfg.get<HookRuntimePreference>("hookRuntime", "auto"),
    nodePath: cfg.get<string>("nodePath", "") || null,
  };
}

/** The folder a command acts on: the only folder, or the one the user picks in a multi-root workspace. */
async function pickWorkspace(purpose: string): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return null;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const choice = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, fsPath: f.uri.fsPath })),
    { placeHolder: vscode.l10n.t("Which folder do you want to {0}?", purpose) }
  );
  return choice?.fsPath ?? null;
}

/** Copilot configurationMigration pattern: removed settings are cleared from every target, with one warning. */
async function migrateRemovedSettings(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration();
  const found: string[] = [];
  for (const key of REMOVED_SETTINGS) {
    const info = cfg.inspect(key);
    if (!info) {
      continue;
    }
    const targets: Array<[unknown, vscode.ConfigurationTarget]> = [
      [info.globalValue, vscode.ConfigurationTarget.Global],
      [info.workspaceValue, vscode.ConfigurationTarget.Workspace],
      [info.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    ];
    for (const [value, target] of targets) {
      if (value !== undefined) {
        try {
          await cfg.update(key, undefined, target);
          found.push(key);
        } catch (error) {
          log.warn(`could not clear removed setting ${key}: ${String((error as Error)?.message ?? error)}`);
        }
      }
    }
  }
  if (found.length && !context.globalState.get<boolean>(MIGRATION_WARNED_KEY)) {
    await context.globalState.update(MIGRATION_WARNED_KEY, true);
    log.warn(`[migrate] settings removed in 0.2.0 cleared: ${[...new Set(found)].join(", ")}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const activationStarted = Date.now();
  const pluginRoot = path.join(context.extensionPath, "resources", "plugin");
  const bundledPricing = path.join(pluginRoot, "config", "pricing.json");
  const extensionVersion = String(context.extension?.packageJSON?.version ?? "");
  const bundledBinary = findBundledBinary(context.extensionPath);
  log = vscode.window.createOutputChannel("AI Cost Optimizer", { log: true });
  context.subscriptions.push(log);
  log.info(`AI Cost Optimizer v${extensionVersion} activated (${vscode.env.appName} ${vscode.version}, ${process.platform}-${process.arch}); bundled hook binary: ${bundledBinary ?? "none (node fallback)"}`);
  const options = (): Options => ({ pluginRoot, binaryPath: bundledBinary, extensionVersion, hookRuntime: settings().hookRuntime, nodePath: settings().nodePath });
  // "Everywhere" scope keeps its state in the extension's own storage (never in a repo, never in ~/.cursor beyond hooks.json + agents).
  const stateRoot = path.join(context.globalStorageUri.fsPath, "cco");
  type Combined = { mode: "user" | "project" | "none"; enabled: boolean; reason: string | null; hookMode: string | null; paused: boolean };
  const combined = (ws: string | null): Combined => {
    const u = userStatus(stateRoot);
    if (u.installed) {
      const paused = ws ? workspacePaused(stateRoot, ws) : false;
      return { mode: "user", enabled: !paused, reason: paused ? "paused_here" : null, hookMode: u.hookMode, paused };
    }
    if (ws) {
      const s = workspaceStatus(ws);
      if (s.installed) {
        return { mode: "project", enabled: s.enabled, reason: s.reason, hookMode: s.hookMode, paused: s.reason === "workspace_opt_out" };
      }
    }
    return { mode: "none", enabled: false, reason: "not_set_up", hookMode: null, paused: false };
  };

  // ---- status bar: "AI Cost" (+ $(warning) when pricing is stale or a tier is inherit); click opens the menu ----
  const status = vscode.window.createStatusBarItem("cco.status", vscode.StatusBarAlignment.Right, 100);
  status.name = "AI Cost Optimizer";
  status.command = "cco.showMenu";
  context.subscriptions.push(status);
  const refreshStatus = () => {
    const ws = firstWorkspace();
    const c = combined(ws);
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    const where = c.mode === "user" ? vscode.l10n.t("on for all projects") : c.mode === "project" ? vscode.l10n.t("on in {0}", path.basename(ws as string)) : "";
    md.appendMarkdown(`**AI Cost Optimizer** — ${c.mode === "none" ? vscode.l10n.t("off") : c.enabled ? where : vscode.l10n.t("paused in {0}", ws ? path.basename(ws) : "")}\n\n`);
    let warn = false;
    let savedUsd = 0;
    // Ground truth from Cursor's own hooks log: a team policy or setting can keep hooks from loading.
    const hooksState = c.mode !== "none" ? hooksLoadedInWindow(context.logUri.fsPath) : { known: false as const };
    if (hooksState.known && !hooksState.loaded) {
      warn = true;
      md.appendMarkdown(`\n$(warning) ${vscode.l10n.t("Cursor did not load the hooks in this window{0}. Routing is off here; a team policy or a Cursor setting may disable hooks.", hooksState.reason ? ` (${hooksState.reason})` : "")}\n`);
    }
    if (c.mode !== "none" && ws) {
      const cost = costStatement(ws, bundledPricing, c.mode === "user" ? { stateRoot, workspaceStateDir: path.join(workspaceStateDir(stateRoot, ws), "state") } : {});
      for (const line of cost.lines) {
        md.appendMarkdown(`- ${line.text}\n`);
      }
      const savings = readSavings(ws, c.mode === "user" ? path.join(workspaceStateDir(stateRoot, ws), "state") : undefined);
      savedUsd = savings.savedUsd;
      const last = readLastDecision(ws, c.mode === "user" ? path.join(workspaceStateDir(stateRoot, ws), "state") : undefined);
      if (last) {
        const tierName = last.tier === "fast" ? vscode.l10n.t("Fast") : last.tier === "balanced" ? vscode.l10n.t("Balanced") : vscode.l10n.t("Deep");
        const numbers = last.estimateUsd !== null ? ` · ${formatUsd(last.estimateUsd)}${last.savedUsd !== null && last.savedUsd >= 0.005 ? `, ${vscode.l10n.t("saved {0}", formatUsd(last.savedUsd))}` : ""}` : "";
        md.appendMarkdown(`\n${vscode.l10n.t("Last task")}: ${tierName} ${vscode.l10n.t("on")} ${modelDisplayName(last.model, loadPricing(null, bundledPricing))}${numbers}\n`);
      }
      md.appendMarkdown(`\n${vscode.l10n.t("Saved about {0} in this project ({1} routed tasks).", formatUsd(savings.savedUsd), String(savings.decisions))}\n`);
      if (cost.warnings.length) {
        warn = true;
        md.appendMarkdown(`\n$(warning) ${cost.warnings.join("; ")} — ${vscode.l10n.t("run **Update models**")}\n`);
      }
      if (!cost.chatModel) {
        md.appendMarkdown(`\n_Rates relative to your chat model appear after the first chat in this project._\n`);
      }
    } else {
      md.appendMarkdown(`${vscode.l10n.t("Routes routine work to cheaper models and shows what it saves.")} [${vscode.l10n.t("Turn on")}](command:cco.installCursorAssets?%7B%22scope%22%3A%22user%22%2C%22confirm%22%3Afalse%7D)\n`);
    }
    const savedText = savedUsd >= 0.01 && vscode.workspace.getConfiguration("cco").get<boolean>("showSavingsInStatusBar", true) ? vscode.l10n.t("Saved {0}", formatUsd(savedUsd)) : "AI Cost";
    status.text = hooksState.known && !hooksState.loaded ? `$(warning) ${vscode.l10n.t("AI Cost: hooks off")}` : warn ? "$(warning) AI Cost" : c.mode === "none" ? `$(zap) ${vscode.l10n.t("AI Cost: Off")}` : c.enabled ? `$(zap) ${savedText}` : `$(zap) ${vscode.l10n.t("AI Cost: Paused")}`;
    status.tooltip = md;
    status.show();
    // context keys drive command enablement (package.json "enablement"), like the first-party extensions
    void vscode.commands.executeCommand("setContext", "cco.mode", c.mode);
    void vscode.commands.executeCommand("setContext", "cco.paused", c.paused);
  };
  refreshStatus();
  const watcher = vscode.workspace.createFileSystemWatcher("**/.cursor/{cco.json,hooks.json,agents/*-tier.md,cco/pricing.json,cco/state/decisions.jsonl,cco/state/sessions/*.json}");
  context.subscriptions.push(watcher, watcher.onDidChange(refreshStatus), watcher.onDidCreate(refreshStatus), watcher.onDidDelete(refreshStatus));
  // "Everywhere" keeps its state in the extension's storage, outside the workspace watcher: watch it too, so the
  // savings figure changes the moment a routed task ends (plus a slow poll as a safety net).
  try {
    fs.mkdirSync(stateRoot, { recursive: true });
    const stateWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(stateRoot), "**/{decisions.jsonl,runtime.json,cco.json,model-limits.json}"));
    context.subscriptions.push(stateWatcher, stateWatcher.onDidChange(refreshStatus), stateWatcher.onDidCreate(refreshStatus), stateWatcher.onDidDelete(refreshStatus));
  } catch (error) {
    log.warn(`[status] state watcher: ${String((error as Error)?.message ?? error)}`);
  }
  const ticker = setInterval(() => { try { refreshStatus(); } catch {} }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(ticker) });

  // ---- doctor + self-check, deferred off activation and fully async (never blocks the extension host) ----
  const SELF_CHECK_KEY = "cco.selfCheckDisabledNotified";
  const selfCheck = async () => {
    const u = userStatus(stateRoot);
    const ws = firstWorkspace();
    const command = u.installed ? userHookCommand(stateRoot) : ws && workspaceStatus(ws).installed ? "node .cursor/cco-hook.mjs preToolUse" : null;
    if (!command) {
      return;
    }
    const cwd = u.installed ? path.join(os.homedir(), ".cursor") : (ws as string);
    const payload = { hook_event_name: "preToolUse", tool_name: "Read", conversation_id: "cco-self-check", tool_input: {}, workspace_roots: [ws ?? os.homedir()] };
    const r = await runHookCommand(command, cwd, payload);
    if (r.ok) {
      log.info(`[self-check] hook answered in ${r.ms} ms`);
      await context.globalState.update(SELF_CHECK_KEY, false);
      return;
    }
    log.error(`[self-check] hook command failed (${r.ms} ms): ${r.error}\ncommand: ${command}\noutput: ${r.output}`);
    const stripped = u.installed ? stripUserHooks(stateRoot) : ws ? stripProjectHooks(ws) : false;
    refreshStatus();
    if (stripped && !context.globalState.get<boolean>(SELF_CHECK_KEY)) {
      await context.globalState.update(SELF_CHECK_KEY, true);
      void notify("warn", vscode.l10n.t("AI Cost Optimizer turned its hooks off: the hook command did not answer ({0}). Cursor works normally without it. Fix the cause (usually Node.js >= 18 on PATH) and run Set Up / Update.", String(r.error)), [vscode.l10n.t("Set Up / Update")]).then((choice) => {
        if (choice === vscode.l10n.t("Set Up / Update")) {
          void vscode.commands.executeCommand("cco.installCursorAssets");
        }
      });
    }
  };
  const stripProjectHooks = (ws: string): boolean => {
    const p = workspacePaths(ws);
    let data: HooksFile | null = null;
    try {
      data = JSON.parse(fs.readFileSync(p.hooksPath, "utf8")) as HooksFile;
    } catch {
      return false;
    }
    const stripped = stripCcoHooks(data);
    if (stripped) {
      fs.writeFileSync(p.hooksPath, `${JSON.stringify(stripped, null, 2)}\n`, "utf8");
    } else {
      fs.rmSync(p.hooksPath, { force: true });
    }
    return true;
  };
  const runDoctor = async () => {
    try {
      const u = await doctorUser(options(), stateRoot);
      if (u.installed) {
        log.info(`[doctor] everywhere: ${u.changed ? `repaired (${u.actions.join(", ")})` : "ok"}`);
      }
    } catch (error) {
      log.error(`[doctor] everywhere: ${String((error as Error)?.message ?? error)}`);
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const result = doctorWorkspace(folder.uri.fsPath, options());
        if (result.installed) {
          log.info(`[doctor] ${folder.uri.fsPath}: mode=${result.hookMode} ${result.changed ? `repaired (${result.actions.join(", ")})` : "ok"}`);
        }
      } catch (error) {
        log.error(`[doctor] ${folder.uri.fsPath}: ${String((error as Error)?.message ?? error)}`);
      }
    }
    refreshStatus();
    await selfCheck();
  };
  const deferred = setTimeout(() => {
    log.info(`[activate] ready in ${Date.now() - activationStarted} ms (${vscode.env.appHost}, remote=${vscode.env.remoteName ?? "none"})`);
    void runDoctor();
  }, 1500);
  // Settings UI → plugin config files (hooks read them on every call). Tier model changes re-map at once.
  const syncSettings = (reason: string) => {
    try {
      const c = combined(firstWorkspace());
      const r = syncSettingsToPluginConfig(stateRoot, firstWorkspace());
      if (r.tierModelsChanged && c.mode !== "none") {
        log.info(`[settings] tier models changed (${reason}); re-mapping`);
        void vscode.commands.executeCommand("cco.installCursorAssets", { scope: c.mode, confirm: false, quiet: true, workspace: firstWorkspace() ?? undefined }).then(() => refreshStatus());
      } else if (r.tierModelsChanged) {
        log.info(`[settings] tier models set (${reason}); applied when the optimizer is turned on`);
      }
    } catch (error) {
      log.error(`[settings] ${String((error as Error)?.message ?? error)}`);
    }
  };
  syncSettings("activation");
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cco.hookRuntime") || e.affectsConfiguration("cco.nodePath")) {
        log.info("[config] hook runtime settings changed; re-running the repair pass");
        void runDoctor();
      }
      if (e.affectsConfiguration("cco.tierModels") || e.affectsConfiguration("cco.enforceRouting") || e.affectsConfiguration("cco.alwaysDelegate") || e.affectsConfiguration("cco.chatBudgetUsd") || e.affectsConfiguration("cco.modelCooldownHours")) {
        syncSettings("settings changed");
      }
      if (e.affectsConfiguration("cco.showSavingsInStatusBar")) {
        refreshStatus();
      }
    })
  );
  context.subscriptions.push({ dispose: () => clearTimeout(deferred) });
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void runDoctor()));

  void migrateRemovedSettings(context);
  // Turns itself on at install, once per machine: the user installed a cost optimizer, so it optimizes. One
  // sentence says so, with Undo. Anyone who removed it is never re-enrolled (the flag stays set).
  const AUTO_ON_KEY = "cco.autoOnDone";
  if (combined(firstWorkspace()).mode === "none" && !context.globalState.get<boolean>(AUTO_ON_KEY) && vscode.workspace.getConfiguration("cco").get<boolean>("autoEnable", true) && process.env.CCO_DISABLE_AUTO_ENABLE !== "1") {
    void context.globalState.update(AUTO_ON_KEY, true);
    const autoOn = setTimeout(() => {
      void vscode.commands.executeCommand("cco.installCursorAssets", { scope: "user", confirm: false, firstRun: true });
    }, 3000);
    context.subscriptions.push({ dispose: () => clearTimeout(autoOn) });
  }

  // ---- commands ----
  const installCmd = vscode.commands.registerCommand("cco.installCursorAssets", async (args?: { confirm?: boolean; workspace?: string; scope?: "user" | "project"; firstRun?: boolean; quiet?: boolean }) => {
    const current = combined(firstWorkspace());
    let scope: "user" | "project" | undefined = args?.scope ?? (current.mode === "user" ? "user" : current.mode === "project" ? "project" : undefined);
    if (!scope) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t("$(globe) Everywhere"), description: vscode.l10n.t("recommended"), detail: vscode.l10n.t("Nothing is written into any project. Cursor's user-level hooks and subagents; state in the extension's storage."), scope: "user" as const },
          { label: vscode.l10n.t("$(folder) This project only"), detail: vscode.l10n.t("8 files under the project's .cursor/ (shareable with teammates via git)."), scope: "project" as const },
        ],
        { placeHolder: vscode.l10n.t("Where should AI Cost Optimizer be set up?") }
      );
      if (!pick) {
        return;
      }
      scope = pick.scope;
    }
    try {
      const opts = options();
      syncSettingsToPluginConfig(stateRoot, firstWorkspace());
      if (scope === "user") {
        // Seconds, not minutes: no per-model probing here (a model the plan refuses is caught at run time and stepped down).
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("AI Cost Optimizer: turning on…"), cancellable: true }, async (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return installUser({ ...opts, probe: false }, stateRoot, firstWorkspace() ?? os.homedir(), controller.signal);
        });
        log.info(`[install] everywhere: hooks=${result.hookMode} via ${result.init.runtime}; agents=${JSON.stringify(result.agents)}`);
        log.info(`[install] cco-init output: ${result.init.stdout.trim()}`);
        refreshStatus();
        // The routing rule arrives through the sessionStart hook, so this window routes from the next chat: no reload.
        const tiers = (["fast-tier", "balanced-tier", "deep-tier"] as const).map((a) => `${a === "fast-tier" ? "Fast" : a === "balanced-tier" ? "Balanced" : "Deep"} → ${modelDisplayName(result.agents[a] ?? "inherit", loadPricing(null, bundledPricing))}`).join(" · ");
        flash(args?.firstRun ? vscode.l10n.t("AI Cost Optimizer is on") : vscode.l10n.t("AI Cost Optimizer: {0}", tiers));
        return result;
      }
      const ws = args?.workspace ?? (await pickWorkspace("set up"));
      if (!ws) {
        if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
          void notify("error", vscode.l10n.t("AI Cost Optimizer: open a folder first."));
        }
        return;
      }
      const plan = plannedFiles(ws, opts);
      log.info(`[install] ${path.basename(ws)}: will write ${plan.creates.join(", ")}; modifies ${plan.modifies.join(", ")}`);
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("AI Cost Optimizer: setting up this workspace (model discovery)"), cancellable: true }, async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return installWorkspace(ws, opts, controller.signal);
      });
      log.info(`[install] ${ws}: hooks=${result.hookMode} (${result.hookEvents.length} events) via ${result.init.runtime}; files=${result.files.length}; agents=${JSON.stringify(result.agents)}`);
      if (result.legacyRemoved.length) {
        log.info(`[install] removed pre-release files: ${result.legacyRemoved.join(", ")}`);
      }
      log.info(`[install] cco-init output: ${result.init.stdout.trim()}`);
      refreshStatus();
      flash(vscode.l10n.t("AI Cost Optimizer is on in {0}", path.basename(ws)));
      return result;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      log.error(`[install] ${message}`);
      void notify("error", vscode.l10n.t("AI Cost Optimizer setup failed: {0}", message.split("\n")[0]));
    }
  });

  const pauseCmd = vscode.commands.registerCommand("cco.togglePause", async () => {
    const ws = firstWorkspace();
    if (!ws) {
      return;
    }
    const c = combined(ws);
    try {
      if (c.mode === "user") {
        const res = await pauseWorkspace(options(), stateRoot, ws, !c.paused);
        if (!res.ran || res.status !== 0) {
          throw new Error(res.error || "could not change the pause state");
        }
      } else if (c.mode === "project") {
        const res = await runPluginScriptAsync(ws, "cco-init.mjs", ["--workspace", ws, c.paused ? "--enable" : "--disable"], options());
        if (!res.ran || res.status !== 0) {
          throw new Error(res.error || "could not change the pause state");
        }
      } else {
        return;
      }
      refreshStatus();
      flash(c.paused ? vscode.l10n.t("AI Cost Optimizer is on again in {0}", path.basename(ws)) : vscode.l10n.t("AI Cost Optimizer is paused in {0}", path.basename(ws)));
    } catch (error) {
      void notify("error", vscode.l10n.t("AI Cost Optimizer: {0}", String((error as Error)?.message ?? error)));
    }
  });

  const uninstallCmd = vscode.commands.registerCommand("cco.uninstallCursorAssets", async (args?: { confirm?: boolean; workspace?: string }) => {
    const u = userStatus(stateRoot);
    if (u.installed && !args?.workspace) {
      try {
        const result = await uninstallUser(options(), stateRoot);
        log.info(`[uninstall] everywhere: via ${result.init.runtime} (status ${result.init.status}); removed ${result.removed.join(", ")}`);
        refreshStatus();
        flash(vscode.l10n.t("AI Cost Optimizer removed from Cursor"));
        return result;
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        log.error(`[uninstall] ${message}`);
        void notify("error", vscode.l10n.t("AI Cost Optimizer removal failed: {0}", message.split("\n")[0]));
        return;
      }
    }
    const ws = args?.workspace ?? (await pickWorkspace("remove AI Cost Optimizer from"));
    if (!ws) {
      if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
        void notify("error", vscode.l10n.t("AI Cost Optimizer: open a folder first."));
      }
      return;
    }
    try {
      const result = await uninstallWorkspace(ws, options());
      log.info(`[uninstall] ${ws}: via ${result.init.runtime} (status ${result.init.status}); removed ${result.removed.join(", ")}`);
      refreshStatus();
      flash(vscode.l10n.t("AI Cost Optimizer removed from {0}", path.basename(ws)));
      return result;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      log.error(`[uninstall] ${ws}: ${message}`);
      void notify("error", vscode.l10n.t("AI Cost Optimizer removal failed: {0}", message.split("\n")[0]));
    }
  });

  // Which model runs each tier: chosen from the models this account can use (the CLI's list, or the catalogue),
  // saved for all projects (Everywhere) or for this project, then the tiers are re-mapped at once.
  const chooseCmd = vscode.commands.registerCommand("cco.chooseTierModels", async () => {
    const ws = firstWorkspace();
    const c = combined(ws);
    if (c.mode === "none") {
      flash(vscode.l10n.t("Turn AI Cost Optimizer on first"));
      return;
    }
    const runtimePath = c.mode === "user" ? path.join(stateRoot, "runtime.json") : path.join(ws as string, RUNTIME_REL);
    const readJson = (file: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    const runtime = readJson(runtimePath) as { discovery?: { availableModels?: string[] } } | null;
    const ids = (runtime?.discovery?.availableModels ?? []).filter((id) => typeof id === "string" && id && !/^auto$/i.test(id));
    if (!ids.length) {
      flash(vscode.l10n.t("No model list yet: run Update models first"));
      return;
    }
    const pricing = loadPricing(null, bundledPricing);
    const current = readTierModels(ws ?? os.homedir(), c.mode === "user" ? path.join(os.homedir(), ".cursor", "agents") : undefined);
    const cfg = vscode.workspace.getConfiguration("cco");
    const target = c.mode === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
    const tierNames: Array<["fast" | "balanced" | "deep", string]> = [["fast", vscode.l10n.t("Fast")], ["balanced", vscode.l10n.t("Balanced")], ["deep", vscode.l10n.t("Deep")]];
    const chosen: Record<string, string> = {};
    for (const [tier, label] of tierNames) {
      const now = current[tier] ?? "inherit";
      const items: Array<vscode.QuickPickItem & { id: string }> = [
        { label: vscode.l10n.t("$(sparkle) Automatic"), description: vscode.l10n.t("cheapest sufficient model for this tier (now {0})", modelDisplayName(now, pricing)), id: "" },
        ...ids.map((id) => ({ label: modelDisplayName(id, pricing), description: id, detail: id === now ? vscode.l10n.t("current") : undefined, id })),
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t("{0} tier: which model should run it?", label), ignoreFocusOut: true });
      if (!pick) {
        return;
      }
      chosen[tier] = pick.id;
    }
    // Written as settings (Settings UI shows and edits the same values); the change handler re-maps the tiers.
    for (const [tier, id] of Object.entries(chosen)) {
      await cfg.update(`tierModels.${tier}`, id || undefined, target);
    }
    await vscode.commands.executeCommand("cco.installCursorAssets", { scope: c.mode, confirm: false, workspace: ws ?? undefined, quiet: true });
    const after = readTierModels(ws ?? os.homedir(), c.mode === "user" ? path.join(os.homedir(), ".cursor", "agents") : undefined);
    flash(vscode.l10n.t("Tier models: Fast → {0} · Balanced → {1} · Deep → {2}", modelDisplayName(after.fast ?? "inherit", pricing), modelDisplayName(after.balanced ?? "inherit", pricing), modelDisplayName(after.deep ?? "inherit", pricing)));
    refreshStatus();
  });

  const showLogCmd = vscode.commands.registerCommand("cco.showOutputChannel", () => log.show(true));

  // Kill switch: hooks off immediately, nothing else touched; Set Up / Update puts them back.
  const hooksOffCmd = vscode.commands.registerCommand("cco.hooksOff", async () => {
    const ws = firstWorkspace();
    const c = combined(ws);
    const stripped = c.mode === "user" ? stripUserHooks(stateRoot) : c.mode === "project" && ws ? stripProjectHooks(ws) : false;
    refreshStatus();
    flash(stripped ? vscode.l10n.t("AI Cost Optimizer hooks are off (Update models restores)") : vscode.l10n.t("No AI Cost Optimizer hooks were active"));
  });

  // Status bar click: a small menu, like the Copilot status item.
  const menuCmd = vscode.commands.registerCommand("cco.showMenu", async () => {
    const ws = firstWorkspace();
    const c = combined(ws);
    const items: Array<vscode.QuickPickItem & { run: () => unknown }> = [];
    if (c.mode === "none") {
      items.push({ label: vscode.l10n.t("$(zap) Turn on"), description: vscode.l10n.t("for all projects (nothing written into them), or this project only"), run: () => vscode.commands.executeCommand("cco.installCursorAssets") });
    } else {
      items.push({ label: vscode.l10n.t("$(graph) Savings and tier rates"), description: vscode.l10n.t("what each tier costs next to your chat model"), run: () => vscode.commands.executeCommand("cco.recommendTier") });
      if (ws) {
        items.push({ label: c.paused ? vscode.l10n.t("$(debug-start) Resume here") : vscode.l10n.t("$(debug-pause) Pause here"), description: c.paused ? undefined : vscode.l10n.t("chats in this project work as before"), run: () => vscode.commands.executeCommand("cco.togglePause") });
      }
      items.push({ label: vscode.l10n.t("$(settings-gear) Choose tier models"), description: vscode.l10n.t("which model runs Fast, Balanced and Deep"), run: () => vscode.commands.executeCommand("cco.chooseTierModels") });
      items.push({ label: vscode.l10n.t("$(sync) Update models"), description: vscode.l10n.t("re-map the tiers and refresh prices"), run: () => vscode.commands.executeCommand("cco.installCursorAssets") });
      items.push({ label: vscode.l10n.t("$(debug-stop) Turn hooks off now"), description: vscode.l10n.t("kill switch; Update models restores"), run: () => vscode.commands.executeCommand("cco.hooksOff") });
      items.push({ label: c.mode === "user" ? "$(trash) Remove from Cursor" : "$(trash) Remove from this workspace", run: () => vscode.commands.executeCommand("cco.uninstallCursorAssets") });
    }
    items.push({ label: vscode.l10n.t("$(output) Show log"), run: () => log.show(true) });
    items.push({ label: vscode.l10n.t("$(bug) Copy diagnostics"), run: () => vscode.commands.executeCommand("cco.collectDiagnostics") });
    items.push({ label: vscode.l10n.t("$(book) Getting started"), run: () => vscode.commands.executeCommand("workbench.action.openWalkthrough", `${EXTENSION_ID}#cco.gettingStarted`, false) });
    const placeHolder = c.mode === "none" ? vscode.l10n.t("AI Cost Optimizer is off") : c.enabled ? (c.mode === "user" ? vscode.l10n.t("AI Cost Optimizer is on for all projects") : vscode.l10n.t("AI Cost Optimizer is on in {0}", ws ? path.basename(ws) : "")) : vscode.l10n.t("AI Cost Optimizer is paused in {0}", ws ? path.basename(ws) : "");
    const choice = await vscode.window.showQuickPick(items, { placeHolder });
    if (choice) {
      await choice.run();
    }
  });

  // Copilot-style cost statement: tier → model • Nx of the chat model ("Rate is counted at Nx.")
  const recommendCmd = vscode.commands.registerCommand("cco.recommendTier", async () => {
    try {
      const editor = vscode.window.activeTextEditor;
      const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
      const input = selected || (await vscode.window.showInputBox({ prompt: "Paste the task/prompt to score (leave empty to only show the tier rates)" })) || "";
      const ws = firstWorkspace();
      const cost = ws ? costStatement(ws, bundledPricing, combined(ws).mode === "user" ? { stateRoot, workspaceStateDir: path.join(workspaceStateDir(stateRoot, ws), "state") } : {}) : null;
      const lines: string[] = [];
      let token: string | null = null;
      if (input.trim()) {
        const decision = decideTier({ scores: heuristicScores(input), override: parseOverride(input), config: DEFAULT_CONFIG });
        token = overrideToken(decision.tier);
        lines.push(`Recommended: ${decision.tier.toUpperCase()}  Token: ${token}  Effort: ${decision.effort}${decision.guardrail ? `  Guardrail: ${decision.guardrail}` : ""}`);
        lines.push(`Scores: ${JSON.stringify(decision.scores)}`);
        lines.push("");
      }
      if (cost) {
        lines.push(cost.chatModel ? `Rates relative to your chat model (${cost.chatModelLabel}):` : "Tier rates (chat model unknown until the first chat in this project):");
        lines.push(...cost.lines.map((l) => l.text));
        if (cost.warnings.length) {
          lines.push("", `Warning: ${cost.warnings.join("; ")} — run /cco-init in a new chat.`);
        }
      } else {
        lines.push("Open a folder to see tier rates.");
      }
      log.info(`[recommend] ${lines.join(" | ")}`);
      type Item = vscode.QuickPickItem & { act?: () => Promise<void> };
      const items: Item[] = lines.filter((l) => l.trim()).map((l) => ({ label: l }));
      if (token && editor) {
        items.unshift({ label: `$(insert) ${vscode.l10n.t("Insert {0} at the cursor", token)}`, act: async () => { await editor.edit((b) => b.insert(editor.selection.active, token)); } });
      }
      if (token) {
        items.unshift({ label: `$(copy) ${vscode.l10n.t("Copy {0}", token)}`, act: async () => { await vscode.env.clipboard.writeText(token); flash(vscode.l10n.t("Copied {0}", token)); } });
      }
      const picked = await vscode.window.showQuickPick(items, { placeHolder: cost?.chatModel ? vscode.l10n.t("Savings and tier rates (next to {0})", cost.chatModelLabel) : vscode.l10n.t("Savings and tier rates") });
      if (picked?.act) {
        await picked.act();
      }
    } catch (error) {
      void notify("error", vscode.l10n.t("AI Cost Optimizer: recommend failed: {0}", String((error as Error)?.message ?? error)));
    }
  });

  const insertAt = async (text: string) => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await editor.edit((b) => b.insert(editor.selection.active, text));
    }
  };
  const insertFast = vscode.commands.registerCommand("cco.insertOverrideFast", () => insertAt("[cco:fast]"));
  const insertBal = vscode.commands.registerCommand("cco.insertOverrideBalanced", () => insertAt("[cco:balanced]"));
  const insertDeep = vscode.commands.registerCommand("cco.insertOverrideDeep", () => insertAt("[cco:deep]"));

  // Diagnostics for bug reports (no prompt text, no paths outside the workspace layout).
  const diagCmd = vscode.commands.registerCommand("cco.collectDiagnostics", async () => {
    try {
      const ws = firstWorkspace();
      const s = ws ? workspaceStatus(ws) : null;
      const p = ws ? workspacePaths(ws) : null;
      let runtime: Record<string, unknown> | null = null;
      let binaryHash: string | null = null;
      if (p) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(p.ccoDir, "runtime.json"), "utf8"));
          runtime = { generatedAt: r.generatedAt, cli: r.cli?.version, profiles: Object.fromEntries(Object.entries(r.profiles || {}).map(([k, v]: [string, unknown]) => [k, (v as { model?: string })?.model])), degraded: r.health?.degraded, notes: r.health?.notes };
        } catch {}
        try {
          binaryHash = crypto.createHash("sha256").update(fs.readFileSync(p.binaryPath)).digest("hex").slice(0, 16);
        } catch {}
      }
      const node = findNode(settings().nodePath);
      let nodeVersion: string | null = null;
      if (node) {
        try {
          nodeVersion = await new Promise<string | null>((resolve) => {
            execFile(node.command, ["-v"], { env: { ...process.env, ...node.env }, timeout: 10_000 }, (e: Error | null, out: string) => resolve(e ? null : String(out).trim() || null));
          });
        } catch {}
      }
      const cmode = combined(ws).mode;
      const cost = ws && cmode !== "none" ? costStatement(ws, bundledPricing, cmode === "user" ? { stateRoot, workspaceStateDir: path.join(workspaceStateDir(stateRoot, ws), "state") } : {}) : null;
      const report = [
        `## AI Cost Optimizer diagnostics`,
        `- extension: ${extensionVersion} (${vscode.env.appName} ${vscode.version}, ${process.platform}-${process.arch}, ${os.release()})`,
        `- settings: hookRuntime=${settings().hookRuntime} nodePath=${settings().nodePath ?? "(default)"}`,
        `- bundled binary: ${bundledBinary ? "yes" : "no"}; node: ${node ? `${node.label} ${nodeVersion ?? ""}`.trim() : "none"}`,
        `- scope: ${cmode}${cmode === "user" ? ` (state root ${stateRoot})` : ""}`,
        `- workspace: ${ws ? `installed=${s?.installed} enabled=${s?.enabled} reason=${s?.reason ?? "-"} hookMode=${s?.hookMode ?? "-"}` : "none open"}`,
        `- installed binary sha256: ${binaryHash ?? "-"}`,
        `- runtime.json: ${runtime ? JSON.stringify(runtime) : "-"}`,
        `- pricing: ${cost ? `${cost.pricing.loadedFrom ? path.basename(path.dirname(cost.pricing.loadedFrom)) + "/pricing.json" : "none"} fetchedAt=${cost.pricing.fetchedAt ?? "-"} stale=${cost.stale}` : "-"}`,
        `- tiers: ${cost ? cost.lines.map((l) => l.text).join(" | ") : "-"}`,
      ].join("\n");
      await vscode.env.clipboard.writeText(report);
      log.info(`[diagnostics]\n${report}`);
      flash(vscode.l10n.t("Diagnostics copied to the clipboard"));
    } catch (error) {
      void notify("error", vscode.l10n.t("AI Cost Optimizer: diagnostics failed: {0}", String((error as Error)?.message ?? error)));
    }
  });

  context.subscriptions.push(installCmd, chooseCmd, uninstallCmd, pauseCmd, showLogCmd, hooksOffCmd, menuCmd, recommendCmd, insertFast, insertBal, insertDeep, diagCmd);

  try {
    decideHookMode(options());
  } catch (error) {
    log.warn(String((error as Error)?.message ?? error));
  }
  return { stateRoot };
}

/**
 * Intentionally a no-op: everything the extension owns is either disposed through context.subscriptions or
 * lives in the workspace (.cursor/) and must survive a reload. Removing workspace files is the explicit
 * "Remove from This Workspace" command; extension removal runs scripts/uninstall.js (vscode:uninstall),
 * which cleans up global storage only.
 */
export function deactivate() {}
