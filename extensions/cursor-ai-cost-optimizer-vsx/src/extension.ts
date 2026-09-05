import * as vscode from "vscode";
import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decideHookMode, doctorWorkspace, findBundledBinary, findNode, installWorkspace, plannedFiles, runPluginScriptAsync, stripCcoHooks, uninstallWorkspace, workspacePaths, workspaceStatus, type HookRuntimePreference, type HooksFile, type Options, hasProjectLeftovers } from "./install";
import { costStatement, formatUsd, readSavings, readLastDecision, readTierModels, loadPricing, modelDisplayName, resolveModelPrice, pickerModels } from "./pricing";
import { syncSettingsToPluginConfig } from "./settings";
import { hooksLoadedInWindow } from "./hooksLog";
import { doctorUser, installUser, pauseWorkspace, stripUserHooks, uninstallUser, userHookCommand, userStatus, workspacePaused, workspaceStateDir, findPluginCopies, retirePluginCopies, recordAgentsWrittenAfterOpen, generatedAgentNames } from "./userScope";
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
/**
 * The Get Started page shows the real tier mapping. Cursor reads a walkthrough's markdown once per session, so
 * each (re)mapping is rendered into the next of three files and a context key switches the step that shows it.
 */
let tiersPage = 0;
/**
 * A remote window (WSL, SSH, containers) lists subagents only when it opens: after a setup or a re-map made in
 * that window, routing works through the names it already knows (aliases), but a first setup needs one reload.
 */
let reloadHint: "finish" | "names" | null = null;
/** A marketplace copy of the Cursor plugin is installed next to the extension (only the user can uninstall it). */
let pluginCopyHint: string | null = null;
function noteReload(kind: "finish" | "names"): void {
  if (vscode.env.remoteName && reloadHint !== "finish") {
    reloadHint = kind;
  }
}
function writeWalkthroughMapping(extensionPath: string, agents: Record<string, string | null>, pricing: ReturnType<typeof loadPricing>): void {
  try {
    const row = (role: string, label: string) => {
      const model = agents[role] ?? "inherit";
      const name = model && model !== "inherit" ? `${modelDisplayName(model, pricing)} ${label}` : `${label} Tier`;
      return `| ${label} | ${modelDisplayName(model, pricing)} | ${name} |`;
    };
    const body = [
      "# It is on. These are your tiers",
      "",
      "Nothing to set up. These were your tiers when this page opened (hover **AI Cost** in the status bar for the current mapping):",
      "",
      "| Tier | Model | Card in the chat |",
      "|---|---|---|",
      row("fast-tier", "Fast"),
      row("balanced-tier", "Balanced"),
      row("deep-tier", "Deep"),
      "",
      "**To change a tier's model:** **Choose tier models** above, the status bar **AI Cost** → **Choose tier models**, or Settings → search \"cost optimizer\" (`costOptimizer.tierModels.fast` / `.balanced` / `.deep`). Everything else stays as it was: your chat model, your project files (nothing is written into them), your workflow.",
      "",
      "The status bar shows what you saved in the current project; its tooltip shows the last task. **Remove from Cursor** in the same menu takes everything back out.",
      "",
    ].join("\n");
    const next = (tiersPage % 3) + 1;
    fs.writeFileSync(path.join(extensionPath, "media", "walkthrough", `step-tiers-${next}.md`), body, "utf8");
    tiersPage = next;
    void vscode.commands.executeCommand("setContext", "cco.tiersPage", next);
  } catch {
    // read-only extension folder: the static page stays
  }
}

/** "$0.5/M in · $2.5/M out" for the model pickers; the raw id only when no price is known. */
function priceLabel(modelId: string, pricing: ReturnType<typeof loadPricing>): string {
  const p = resolveModelPrice(modelId, pricing);
  if (p.input === null || p.output === null) {
    return modelId;
  }
  const money = (x: number) => (x >= 1 ? `$${Number(x.toFixed(2))}` : `$${Number(x.toFixed(3))}`);
  return `${money(p.input)}/M in · ${money(p.output)}/M out`;
}

/** Feedback for an action the user just took: 4 s in the status bar, never a popup. */
function flash(text: string): void {
  vscode.window.setStatusBarMessage(`$(zap) ${text}`, 4000);
}

function settings(): Settings {
  const cfg = vscode.workspace.getConfiguration("costOptimizer");
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
      const fastLine = cost.lines.find((l) => l.tier === "fast");
      if (fastLine && fastLine.multiplier !== null && fastLine.multiplier >= 0.995 && cost.chatModelLabel) {
        md.appendMarkdown(`\n${vscode.l10n.t("{0} already costs no more than the Fast tier: routine work stays in this chat; risky or complex work still goes to Deep.", cost.chatModelLabel)}\n`);
      }
      const savings = readSavings(ws, c.mode === "user" ? path.join(workspaceStateDir(stateRoot, ws), "state") : undefined);
      savedUsd = savings.savedUsd;
      const last = readLastDecision(ws, c.mode === "user" ? path.join(workspaceStateDir(stateRoot, ws), "state") : undefined);
      if (last) {
        const tierName = last.tier === "fast" ? vscode.l10n.t("Fast") : last.tier === "balanced" ? vscode.l10n.t("Balanced") : vscode.l10n.t("Deep");
        const numbers = last.estimateUsd !== null ? ` · ${formatUsd(last.estimateUsd)}${last.savedUsd !== null && last.savedUsd >= 0.005 ? `, ${vscode.l10n.t("saved {0}", formatUsd(last.savedUsd))}` : ""}` : "";
        md.appendMarkdown(`\n${vscode.l10n.t("Last task")}: ${tierName} ${vscode.l10n.t("on")} ${modelDisplayName(last.model, loadPricing(null, bundledPricing))}${numbers}\n`);
      }
      md.appendMarkdown(`\n${savings.decisions === 1 ? vscode.l10n.t("Saved about {0} in this project (1 routed task).", formatUsd(savings.savedUsd)) : vscode.l10n.t("Saved about {0} in this project ({1} routed tasks).", formatUsd(savings.savedUsd), String(savings.decisions))}\n`);
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
    const savedText = savedUsd >= 0.01 && vscode.workspace.getConfiguration("costOptimizer").get<boolean>("showSavingsInStatusBar", true) ? vscode.l10n.t("Saved {0}", formatUsd(savedUsd)) : "AI Cost";
    if (pluginCopyHint && c.mode !== "none") {
      md.appendMarkdown(`\n$(warning) ${vscode.l10n.t("The Cost Optimizer plugin is also installed in Cursor (Settings → Plugins): uninstall it, the extension replaces it. Its subagents run on your chat model and its hooks run a second time.")}\n`);
    }
    if (reloadHint && c.mode === "user" && c.enabled) {
      md.appendMarkdown(`\n${reloadHint === "finish" ? vscode.l10n.t("Cursor lists subagents when a window opens: reload this window once to start routing here.") : vscode.l10n.t("Cursor lists subagents when a window opens: this window keeps routing under the previous names until it is reloaded.")}\n`);
    }
    status.text = hooksState.known && !hooksState.loaded ? `$(warning) ${vscode.l10n.t("AI Cost: hooks off")}` : warn ? "$(warning) AI Cost" : c.mode === "none" ? `$(zap) ${vscode.l10n.t("AI Cost: Off")}` : c.enabled ? (reloadHint === "finish" ? `$(zap) ${vscode.l10n.t("AI Cost: reload to finish")}` : `$(zap) ${savedText}`) : `$(zap) ${vscode.l10n.t("AI Cost: Paused")}`;
    status.tooltip = md;
    status.show();
    // context keys drive command enablement (package.json "enablement"), like the first-party extensions
    void vscode.commands.executeCommand("setContext", "cco.mode", c.mode);
    void vscode.commands.executeCommand("setContext", "cco.paused", c.paused);
  };
  refreshStatus();
  const watcher = vscode.workspace.createFileSystemWatcher("**/.cursor/{cco.json,hooks.json,agents/*.md,cco/pricing.json,cco/state/decisions.jsonl,cco/state/sessions/*.json}");
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
    const namesBeforeDoctor = generatedAgentNames();
    try {
      const copies = findPluginCopies();
      if (copies.length) {
        const r = retirePluginCopies(stateRoot, copies);
        if (r.retired.length) {
          log.info(`[doctor] retired plugin copies (moved under ${path.join(stateRoot, "retired-plugins")}): ${r.retired.join(", ")}`);
          flash(vscode.l10n.t("An older copy of the Cost Optimizer plugin was retired; the extension replaces it"));
          noteReload("names");
        }
        pluginCopyHint = r.marketplace[0] ?? null;
        if (pluginCopyHint) {
          log.warn(`[doctor] the Cursor plugin is also installed (${pluginCopyHint}); its cco-* subagents run on the chat model and its hooks run twice: uninstall it in Cursor Settings → Plugins`);
        }
      } else {
        pluginCopyHint = null;
      }
    } catch (error) {
      log.error(`[doctor] plugin copies: ${String((error as Error)?.message ?? error)}`);
    }
    try {
      const u = await doctorUser(options(), stateRoot);
      if (u.installed) {
        log.info(`[doctor] everywhere: ${u.changed ? `repaired (${u.actions.join(", ")})` : "ok"}`);
        if (u.changed && u.actions.some((a) => a === "legacy_agents_replaced" || a === "repointed_after_update")) {
          const rec = recordAgentsWrittenAfterOpen(stateRoot, namesBeforeDoctor, activationStarted, Boolean(vscode.env.remoteName));
          if (rec.written) {
            noteReload(rec.noneOfOurs ? "finish" : "names");
            log.info(`[doctor] remote window: subagents rewritten after it opened; routing continues under the previous names until a reload`);
          }
        }
      }
    } catch (error) {
      log.error(`[doctor] everywhere: ${String((error as Error)?.message ?? error)}`);
    }
    const everywhere = userStatus(stateRoot).installed;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        // Everywhere covers this project: project-scope files an earlier version (or a chat-driven setup) left in
        // it would run a second copy of the hooks and older subagents next to ours. Take them out, once.
        if (everywhere && hasProjectLeftovers(folder.uri.fsPath)) {
          const u = await uninstallWorkspace(folder.uri.fsPath, options());
          log.info(`[doctor] ${folder.uri.fsPath}: project-scope files from an earlier setup removed (Everywhere covers this project): ${u.removed.join(", ")}`);
          continue;
        }
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
  try {
    const u0 = userStatus(stateRoot);
    if (u0.installed) {
      writeWalkthroughMapping(context.extensionPath, u0.agents, loadPricing(null, bundledPricing));
    }
  } catch {}
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("costOptimizer.hookRuntime") || e.affectsConfiguration("costOptimizer.nodePath")) {
        log.info("[config] hook runtime settings changed; re-running the repair pass");
        void runDoctor();
      }
      if (e.affectsConfiguration("costOptimizer.tierModels") || e.affectsConfiguration("costOptimizer.enforceRouting") || e.affectsConfiguration("costOptimizer.alwaysDelegate") || e.affectsConfiguration("costOptimizer.chatBudgetUsd") || e.affectsConfiguration("costOptimizer.modelCooldownHours")) {
        syncSettings("settings changed");
      }
      if (e.affectsConfiguration("costOptimizer.showSavingsInStatusBar")) {
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
  if (combined(firstWorkspace()).mode === "none" && !context.globalState.get<boolean>(AUTO_ON_KEY) && vscode.workspace.getConfiguration("costOptimizer").get<boolean>("autoEnable", true) && process.env.CCO_DISABLE_AUTO_ENABLE !== "1") {
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
        const namesBefore = generatedAgentNames();
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("AI Cost Optimizer: turning on…"), cancellable: true }, async (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return installUser({ ...opts, probe: false }, stateRoot, firstWorkspace() ?? os.homedir(), controller.signal);
        });
        log.info(`[install] everywhere: hooks=${result.hookMode} via ${result.init.runtime}; agents=${JSON.stringify(result.agents)}`);
        log.info(`[install] cco-init output: ${result.init.stdout.trim()}`);
        refreshStatus();
        // Project-scope files an earlier version left in the open folders are cleaned up now that Everywhere covers them.
        void runDoctor();
        // The routing rule arrives through the sessionStart hook, so this window routes from the next chat: no reload.
        const tiers = (["fast-tier", "balanced-tier", "deep-tier"] as const).map((a) => `${a === "fast-tier" ? "Fast" : a === "balanced-tier" ? "Balanced" : "Deep"} → ${modelDisplayName(result.agents[a] ?? "inherit", loadPricing(null, bundledPricing))}`).join(" · ");
        flash(args?.firstRun ? vscode.l10n.t("AI Cost Optimizer is on") : vscode.l10n.t("AI Cost Optimizer: {0}", tiers));
        // A remote window lists subagents only when it opens: tell the hooks what this window can still use.
        const rec = recordAgentsWrittenAfterOpen(stateRoot, namesBefore, activationStarted, Boolean(vscode.env.remoteName));
        if (rec.written) {
          noteReload(rec.noneOfOurs ? "finish" : "names");
          log.info(`[install] remote window: subagents written after it opened; ${rec.noneOfOurs ? "work stays in the chat until a reload" : "routing continues under the previous names until a reload"}`);
        }
        refreshStatus();
        writeWalkthroughMapping(context.extensionPath, result.agents, loadPricing(null, bundledPricing));
        if (args?.firstRun && !context.globalState.get<boolean>("cco.walkthroughShown")) {
          void context.globalState.update("cco.walkthroughShown", true);
          void vscode.commands.executeCommand("workbench.action.openWalkthrough", `${EXTENSION_ID}#cco.gettingStarted`, false);
        }
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
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("AI Cost Optimizer: setting up this workspace (model discovery)"), cancellable: true }, async (_progress, token) => {
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
    const current = readTierModels(ws ?? os.homedir(), c.mode === "user" ? path.join(os.homedir(), ".cursor", "agents") : undefined, c.mode === "user" ? path.join(stateRoot, "agent-names.json") : undefined);
    const cfg = vscode.workspace.getConfiguration("costOptimizer");
    const target = c.mode === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
    const tierNames: Array<["fast" | "balanced" | "deep", string]> = [["fast", vscode.l10n.t("Fast")], ["balanced", vscode.l10n.t("Balanced")], ["deep", vscode.l10n.t("Deep")]];
    const chosen: Record<string, string> = {};
    for (const [tier, label] of tierNames) {
      const now = current[tier] ?? "inherit";
      const items: Array<vscode.QuickPickItem & { id: string }> = [
        { label: vscode.l10n.t("$(sparkle) Automatic"), description: vscode.l10n.t("cheapest sufficient model for this tier (now {0})", modelDisplayName(now, pricing)), id: "" },
        ...pickerModels(ids, pricing).map((row) => ({ label: row.label, description: priceLabel(row.id, pricing), detail: row.label === modelDisplayName(now, pricing) ? vscode.l10n.t("current") : undefined, id: row.id })),
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t("{0} tier: which model should run it?", label), ignoreFocusOut: true });
      if (!pick) {
        return;
      }
      chosen[tier] = pick.id;
    }
    // Written as settings (Settings UI shows and edits the same values); the change handler re-maps the tiers once.
    let changed = false;
    for (const [tier, id] of Object.entries(chosen)) {
      const before = cfg.inspect<string>(`tierModels.${tier}`);
      const prev = target === vscode.ConfigurationTarget.Global ? before?.globalValue : before?.workspaceValue;
      if ((prev ?? "") !== id) {
        changed = true;
        await cfg.update(`tierModels.${tier}`, id || undefined, target);
      }
    }
    if (!changed) {
      flash(vscode.l10n.t("Tier models unchanged"));
      return;
    }
    await new Promise((r) => setTimeout(r, 4000));
    const after = readTierModels(ws ?? os.homedir(), c.mode === "user" ? path.join(os.homedir(), ".cursor", "agents") : undefined, c.mode === "user" ? path.join(stateRoot, "agent-names.json") : undefined);
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
    if (pluginCopyHint && c.mode !== "none") {
      items.push({ label: vscode.l10n.t("$(extensions) Uninstall the Cursor plugin"), description: vscode.l10n.t("the extension replaces it; its subagents run on your chat model"), run: () => vscode.commands.executeCommand("aiSettings.action.open").then(undefined, () => flash(vscode.l10n.t("Cursor Settings → Plugins → AI Cost Optimizer → Uninstall"))) });
    }
    if (reloadHint && c.mode === "user") {
      items.push({ label: vscode.l10n.t("$(refresh) Reload window"), description: reloadHint === "finish" ? vscode.l10n.t("finishes the setup in this window (Cursor lists subagents when a window opens)") : vscode.l10n.t("shows the new subagent names in this window"), run: () => vscode.commands.executeCommand("workbench.action.reloadWindow") });
    }
    if (c.mode === "none") {
      items.push({ label: vscode.l10n.t("$(zap) Turn on"), description: vscode.l10n.t("for all projects (nothing written into them), or this project only"), run: () => vscode.commands.executeCommand("cco.installCursorAssets") });
    } else {
      items.push({ label: vscode.l10n.t("$(graph) Savings and tier rates"), description: vscode.l10n.t("what each tier costs next to your chat model"), run: () => vscode.commands.executeCommand("cco.recommendTier") });
      if (ws) {
        items.push({ label: c.paused ? vscode.l10n.t("$(debug-start) Resume here") : vscode.l10n.t("$(debug-pause) Pause here"), description: c.paused ? undefined : vscode.l10n.t("chats in this project work as before"), run: () => vscode.commands.executeCommand("cco.togglePause") });
      }
      items.push({ label: vscode.l10n.t("$(settings-gear) Choose tier models"), description: vscode.l10n.t("which model runs Fast, Balanced and Deep"), run: () => vscode.commands.executeCommand("cco.chooseTierModels") });
      items.push({ label: vscode.l10n.t("$(sync) Update models"), description: vscode.l10n.t("re-map the tiers and refresh prices"), run: () => vscode.commands.executeCommand("cco.installCursorAssets") });
      items.push({ label: vscode.l10n.t("$(debug-stop) Emergency stop"), description: vscode.l10n.t("stops the optimizer in every project at once; Update models turns it back on"), run: () => vscode.commands.executeCommand("cco.hooksOff") });
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
  const recommendCmd = vscode.commands.registerCommand("cco.recommendTier", async (args?: { score?: boolean }) => {
    try {
      const ws = firstWorkspace();
      const userMode = ws ? combined(ws).mode === "user" : false;
      const stateDir = ws && userMode ? path.join(workspaceStateDir(stateRoot, ws), "state") : undefined;
      const cost = ws ? costStatement(ws, bundledPricing, userMode ? { stateRoot, workspaceStateDir: stateDir } : {}) : null;
      type Item = vscode.QuickPickItem & { act?: () => Promise<void> };
      const items: Item[] = [];
      // Scoring a prompt (power users): only when asked for through the sub-item or with a selection in the editor.
      const editor = vscode.window.activeTextEditor;
      const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
      if (args?.score || selected) {
        const input = selected || (await vscode.window.showInputBox({ prompt: vscode.l10n.t("Paste a prompt to see which tier it would get") })) || "";
        if (input.trim()) {
          const decision = decideTier({ scores: heuristicScores(input), override: parseOverride(input), config: DEFAULT_CONFIG });
          const token = overrideToken(decision.tier);
          items.push({ label: vscode.l10n.t("This prompt would go to {0} (effort {1}{2})", decision.tier.toUpperCase(), String(decision.effort), decision.guardrail ? `, ${decision.guardrail}` : "") });
          items.push({ label: `$(copy) ${vscode.l10n.t("Copy {0} to force that tier", token)}`, act: async () => { await vscode.env.clipboard.writeText(token); flash(vscode.l10n.t("Copied {0}", token)); } });
          items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        }
      }
      if (ws && cost) {
        const savings = readSavings(ws, stateDir);
        const last = readLastDecision(ws, stateDir);
        items.push({ label: `$(zap) ${savings.decisions === 1 ? vscode.l10n.t("Saved about {0} in this project (1 routed task)", formatUsd(savings.savedUsd)) : vscode.l10n.t("Saved about {0} in this project ({1} routed tasks)", formatUsd(savings.savedUsd), String(savings.decisions))}` });
        if (last) {
          const tierName = last.tier === "fast" ? vscode.l10n.t("Fast") : last.tier === "balanced" ? vscode.l10n.t("Balanced") : vscode.l10n.t("Deep");
          items.push({ label: `$(history) ${vscode.l10n.t("Last task")}: ${tierName} ${vscode.l10n.t("on")} ${modelDisplayName(last.model, cost.pricing)}${last.estimateUsd !== null ? ` · ${formatUsd(last.estimateUsd)}` : ""}${last.savedUsd !== null && last.savedUsd >= 0.005 ? `, ${vscode.l10n.t("saved {0}", formatUsd(last.savedUsd))}` : ""}` });
        }
        items.push({ label: cost.chatModel ? vscode.l10n.t("Tier rates next to {0}", cost.chatModelLabel) : vscode.l10n.t("Tier rates"), kind: vscode.QuickPickItemKind.Separator });
        for (const l of cost.lines) {
          items.push({ label: l.text });
        }
        if (cost.warnings.length) {
          items.push({ label: `$(warning) ${cost.warnings.join("; ")}` });
        }
      } else {
        items.push({ label: vscode.l10n.t("Open a folder to see savings and tier rates.") });
      }
      if (!args?.score) {
        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: `$(search) ${vscode.l10n.t("Score a prompt…")}`, description: vscode.l10n.t("which tier a given request would get"), act: async () => { await vscode.commands.executeCommand("cco.recommendTier", { score: true }); } });
      }
      const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t("Savings and tier rates") });
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
