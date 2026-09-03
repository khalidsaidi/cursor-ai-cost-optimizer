import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decideHookMode, doctorWorkspace, findBundledBinary, findNode, installWorkspace, plannedFiles, runPluginScript, uninstallWorkspace, workspacePaths, workspaceStatus, type HookRuntimePreference, type Options } from "./install";
import { costStatement, formatUsd, readSavings } from "./pricing";
import { doctorUser, installUser, pauseWorkspace, uninstallUser, userStatus, workspacePaused, workspaceStateDir } from "./userScope";
import { decideTier, heuristicScores, overrideToken, parseOverride, DEFAULT_CONFIG } from "./scorer";

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
    { placeHolder: `Which folder do you want to ${purpose}?` }
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
    void notify("warn", `AI Cost Optimizer: the settings ${[...new Set(found)].join(", ")} were removed in 0.2.0 and have been cleared (routing is configured in .cursor/cco.json now).`);
  }
}

export function activate(context: vscode.ExtensionContext) {
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
    const where = c.mode === "user" ? "everywhere" : c.mode === "project" ? `in \`${path.basename(ws as string)}\`` : "";
    md.appendMarkdown(`**AI Cost Optimizer** — ${c.mode === "none" ? "not set up" : c.enabled ? `active ${where}` : `paused ${ws ? `in \`${path.basename(ws)}\`` : ""}`}${c.hookMode ? ` · hooks: ${c.hookMode}` : ""}\n\n`);
    let warn = false;
    if (c.mode !== "none" && ws) {
      const cost = costStatement(ws, bundledPricing, c.mode === "user" ? { stateRoot, workspaceStateDir: path.join(workspaceStateDir(stateRoot, ws), "state") } : {});
      for (const line of cost.lines) {
        md.appendMarkdown(`- ${line.text}\n`);
      }
      const savings = readSavings(ws, c.mode === "user" ? path.join(workspaceStateDir(stateRoot, ws), "state") : undefined);
      md.appendMarkdown(`\nest. savings ${formatUsd(savings.savedUsd)} in this project (${savings.decisions} routed task${savings.decisions === 1 ? "" : "s"}, est. ${formatUsd(savings.estimatedUsd)} spent on tiers)\n`);
      if (cost.warnings.length) {
        warn = true;
        md.appendMarkdown(`\n$(warning) ${cost.warnings.join("; ")} — run **Set Up / Update**\n`);
      }
      if (!cost.chatModel) {
        md.appendMarkdown(`\n_Rates relative to your chat model appear after the first chat in this project._\n`);
      }
    } else {
      md.appendMarkdown(`Not set up yet. [Set up](command:cco.installCursorAssets)\n`);
    }
    status.text = warn ? "$(warning) AI Cost" : c.mode === "none" ? "$(zap) AI Cost" : c.enabled ? "$(zap) AI Cost" : "$(zap) AI Cost: paused";
    status.tooltip = md;
    status.show();
  };
  refreshStatus();
  const watcher = vscode.workspace.createFileSystemWatcher("**/.cursor/{cco.json,hooks.json,agents/cco-*.md,cco/pricing.json,cco/state/decisions.jsonl,cco/state/sessions/*.json}");
  context.subscriptions.push(watcher, watcher.onDidChange(refreshStatus), watcher.onDidCreate(refreshStatus), watcher.onDidDelete(refreshStatus));

  // ---- doctor on activation ----
  const runDoctor = () => {
    try {
      const u = doctorUser(options(), stateRoot);
      if (u.installed) {
        log.info(`[doctor] everywhere: ${u.changed ? `repaired (${u.actions.join(", ")})` : "ok"}`);
      }
    } catch (error) {
      void notify("error", `AI Cost Optimizer doctor failed: ${String((error as Error)?.message ?? error)}`);
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const result = doctorWorkspace(folder.uri.fsPath, options());
        if (result.installed) {
          log.info(`[doctor] ${folder.uri.fsPath}: mode=${result.hookMode} ${result.changed ? `repaired (${result.actions.join(", ")})` : "ok"}`);
        }
      } catch (error) {
        void notify("error", `AI Cost Optimizer doctor failed in ${path.basename(folder.uri.fsPath)}: ${String((error as Error)?.message ?? error)}`);
      }
    }
    refreshStatus();
  };
  runDoctor();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(runDoctor));

  // No first-run toast: VS Code/Cursor opens the walkthrough for a newly installed extension, the status bar
  // item shows the state, and nothing is written until the user runs the install command.
  void migrateRemovedSettings(context);

  // ---- commands ----
  const installCmd = vscode.commands.registerCommand("cco.installCursorAssets", async (args?: { confirm?: boolean; workspace?: string; scope?: "user" | "project" }) => {
    const current = combined(firstWorkspace());
    let scope: "user" | "project" | undefined = args?.scope ?? (current.mode === "user" ? "user" : current.mode === "project" ? "project" : undefined);
    if (!scope) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "$(globe) Everywhere", description: "recommended", detail: "Nothing is written into any project. Cursor's user-level hooks and subagents; state in the extension's storage.", scope: "user" as const },
          { label: "$(folder) This project only", detail: "8 files under the project's .cursor/ (shareable with teammates via git).", scope: "project" as const },
        ],
        { placeHolder: "Where should AI Cost Optimizer be set up?" }
      );
      if (!pick) {
        return;
      }
      scope = pick.scope;
    }
    try {
      const opts = options();
      if (scope === "user") {
        if (args?.confirm !== false) {
          const detail = [
            `Writes only Cursor's own user-level config and this extension's storage:`,
            `  ~/.cursor/hooks.json  (CCO entries merged; other entries kept)`,
            `  ~/.cursor/agents/cco-{fast,balanced,deep,verifier,explore}.md`,
            `  extension storage: model mapping, prices, per-project state`,
            ``,
            `No project files. Hooks: ${decideHookModeSafe(opts) === "binary" ? "bundled cco-hook binary" : "Node.js"}, about 0.05 s per tool call.`,
            `Pause per project from the AI Cost status menu. Remove takes everything back out.`,
          ].join("\n");
          const choice = await vscode.window.showInformationMessage("Set up AI Cost Optimizer everywhere?", { modal: true, detail }, "Set up");
          if (choice !== "Set up") {
            return;
          }
        }
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "AI Cost Optimizer: setting up (model discovery)" }, async () => installUser(opts, stateRoot, firstWorkspace() ?? os.homedir()));
        log.info(`[install] everywhere: hooks=${result.hookMode} via ${result.init.runtime}; agents=${JSON.stringify(result.agents)}`);
        log.info(`[install] cco-init output: ${result.init.stdout.trim()}`);
        refreshStatus();
        void vscode.window.showInformationMessage("AI Cost Optimizer is set up. Start a new chat to use it.", "Show details").then((choice) => {
          if (choice === "Show details") {
            log.show(true);
          }
        });
        return result;
      }
      const ws = args?.workspace ?? (await pickWorkspace("set up"));
      if (!ws) {
        if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
          void notify("error", "AI Cost Optimizer: open a folder first.");
        }
        return;
      }
      const plan = plannedFiles(ws, opts);
      if (args?.confirm !== false) {
        const detail = [
          `Writes 8 files under ${path.basename(ws)}/.cursor/ (they will show up in git status):`,
          ...plan.creates.map((f) => `  ${f}`),
          ``,
          `Modifies: ${plan.modifies.join(", ")}`,
          `Hooks: ${plan.hookMode === "binary" ? "bundled cco-hook binary (no Node.js needed)" : "node .cursor/cco-hook.mjs, about 0.05 s per tool call"}`,
          ``,
          `Commit these to share the setup with teammates (they are a no-op without the extension), or add .cursor/ to .gitignore.`,
          `Nothing is written outside this folder. Remove from This Workspace takes it all back out.`,
        ].join("\n");
        const choice = await vscode.window.showInformationMessage(`Set up AI Cost Optimizer in ${path.basename(ws)}/.cursor/?`, { modal: true, detail }, "Set up");
        if (choice !== "Set up") {
          return;
        }
      }
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "AI Cost Optimizer: setting up this workspace (model discovery)" }, async () => installWorkspace(ws, opts));
      log.info(`[install] ${ws}: hooks=${result.hookMode} (${result.hookEvents.length} events) via ${result.init.runtime}; files=${result.files.length}; agents=${JSON.stringify(result.agents)}`);
      if (result.legacyRemoved.length) {
        log.info(`[install] removed pre-release files: ${result.legacyRemoved.join(", ")}`);
      }
      log.info(`[install] cco-init output: ${result.init.stdout.trim()}`);
      refreshStatus();
      void vscode.window.showInformationMessage(`AI Cost Optimizer is set up for ${path.basename(ws)}. Start a new chat to use it.`, "Show details").then((choice) => {
        if (choice === "Show details") {
          log.show(true);
        }
      });
      return result;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      log.error(`[install] ${message}`);
      void notify("error", `AI Cost Optimizer setup failed: ${message.split("\n")[0]}`);
    }
  });

  const decideHookModeSafe = (opts: Options): string => {
    try {
      return decideHookMode(opts);
    } catch {
      return "node";
    }
  };

  const pauseCmd = vscode.commands.registerCommand("cco.togglePause", async () => {
    const ws = firstWorkspace();
    if (!ws) {
      return;
    }
    const c = combined(ws);
    try {
      if (c.mode === "user") {
        const res = pauseWorkspace(options(), stateRoot, ws, !c.paused);
        if (!res.ran || res.status !== 0) {
          throw new Error(res.error || "could not change the pause state");
        }
      } else if (c.mode === "project") {
        const res = runPluginScript(ws, "cco-init.mjs", ["--workspace", ws, c.paused ? "--enable" : "--disable"], options());
        if (!res.ran || res.status !== 0) {
          throw new Error(res.error || "could not change the pause state");
        }
      } else {
        return;
      }
      refreshStatus();
      void vscode.window.showInformationMessage(`AI Cost Optimizer is ${c.paused ? "active again" : "paused"} in ${path.basename(ws)}.`);
    } catch (error) {
      void notify("error", `AI Cost Optimizer: ${String((error as Error)?.message ?? error)}`);
    }
  });

  const uninstallCmd = vscode.commands.registerCommand("cco.uninstallCursorAssets", async (args?: { confirm?: boolean; workspace?: string }) => {
    const u = userStatus(stateRoot);
    if (u.installed && !args?.workspace) {
      if (args?.confirm !== false) {
        const choice = await vscode.window.showWarningMessage("Remove AI Cost Optimizer from Cursor?", { modal: true, detail: "Removes CCO's entries from ~/.cursor/hooks.json, the generated cco-* subagents from ~/.cursor/agents, and the extension's state. Other hook entries and your own files are kept. Nothing is left behind." }, "Remove");
        if (choice !== "Remove") {
          return;
        }
      }
      try {
        const result = uninstallUser(options(), stateRoot);
        log.info(`[uninstall] everywhere: via ${result.init.runtime} (status ${result.init.status}); removed ${result.removed.join(", ")}`);
        refreshStatus();
        void vscode.window.showInformationMessage("AI Cost Optimizer was removed from Cursor.");
        return result;
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        log.error(`[uninstall] ${message}`);
        void notify("error", `AI Cost Optimizer removal failed: ${message.split("\n")[0]}`);
        return;
      }
    }
    const ws = args?.workspace ?? (await pickWorkspace("remove AI Cost Optimizer from"));
    if (!ws) {
      if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
        void notify("error", "AI Cost Optimizer: open a folder first.");
      }
      return;
    }
    if (args?.confirm !== false) {
      const choice = await vscode.window.showWarningMessage(`Remove AI Cost Optimizer from ${path.basename(ws)}/.cursor/?`, { modal: true, detail: "Removes CCO's hook entries, the generated cco-* subagents, the rule it added, and its state folder. Your own files and other tools' hook entries are kept." }, "Remove");
      if (choice !== "Remove") {
        return;
      }
    }
    try {
      const result = uninstallWorkspace(ws, options());
      log.info(`[uninstall] ${ws}: via ${result.init.runtime} (status ${result.init.status}); removed ${result.removed.join(", ")}`);
      refreshStatus();
      void vscode.window.showInformationMessage(`AI Cost Optimizer was removed from ${path.basename(ws)}.`);
      return result;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      log.error(`[uninstall] ${ws}: ${message}`);
      void notify("error", `AI Cost Optimizer removal failed: ${message.split("\n")[0]}`);
    }
  });

  const showLogCmd = vscode.commands.registerCommand("cco.showOutputChannel", () => log.show(true));

  // Status bar click: a small menu, like the Copilot status item.
  const menuCmd = vscode.commands.registerCommand("cco.showMenu", async () => {
    const ws = firstWorkspace();
    const c = combined(ws);
    const items: Array<vscode.QuickPickItem & { run: () => unknown }> = [];
    if (c.mode === "none") {
      items.push({ label: "$(zap) Set up", description: "everywhere (nothing in projects) or this project only", run: () => vscode.commands.executeCommand("cco.installCursorAssets") });
    } else {
      items.push({ label: "$(graph) Tier rates and savings", description: "what each tier costs relative to your chat model", run: () => vscode.commands.executeCommand("cco.recommendTier") });
      if (ws) {
        items.push({ label: c.paused ? "$(debug-start) Resume in this project" : "$(debug-pause) Pause in this project", run: () => vscode.commands.executeCommand("cco.togglePause") });
      }
      items.push({ label: "$(sync) Update setup", description: "re-run model discovery and refresh files", run: () => vscode.commands.executeCommand("cco.installCursorAssets") });
      items.push({ label: c.mode === "user" ? "$(trash) Remove from Cursor" : "$(trash) Remove from this workspace", run: () => vscode.commands.executeCommand("cco.uninstallCursorAssets") });
    }
    items.push({ label: "$(output) Show log", run: () => log.show(true) });
    items.push({ label: "$(bug) Copy diagnostics", run: () => vscode.commands.executeCommand("cco.collectDiagnostics") });
    items.push({ label: "$(book) Getting started", run: () => vscode.commands.executeCommand("workbench.action.openWalkthrough", `${EXTENSION_ID}#cco.gettingStarted`, false) });
    const placeHolder = c.mode === "none" ? "AI Cost Optimizer" : `AI Cost Optimizer is ${c.enabled ? "active" : "paused"}${ws ? ` in ${path.basename(ws)}` : ""}${c.mode === "user" ? " (set up everywhere)" : ""}`;
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
      const items = token ? ["Copy token", "Insert token"] : [];
      const action = await notify("info", lines[0], items, { modal: true, detail: lines.slice(1).join("\n") });
      if (action === "Copy token" && token) {
        await vscode.env.clipboard.writeText(token);
      } else if (action === "Insert token" && token && editor) {
        await editor.edit((b) => b.insert(editor.selection.active, token as string));
      }
    } catch (error) {
      void notify("error", `AI Cost Optimizer: recommend failed: ${String((error as Error)?.message ?? error)}`);
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
          nodeVersion = require("child_process").spawnSync(node.command, ["-v"], { encoding: "utf8", env: { ...process.env, ...node.env }, timeout: 10_000 }).stdout?.trim() || null;
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
      void notify("info", "AI Cost Optimizer diagnostics copied to the clipboard.");
    } catch (error) {
      void notify("error", `AI Cost Optimizer: diagnostics failed: ${String((error as Error)?.message ?? error)}`);
    }
  });

  context.subscriptions.push(installCmd, uninstallCmd, pauseCmd, showLogCmd, menuCmd, recommendCmd, insertFast, insertBal, insertDeep, diagCmd);

  try {
    decideHookMode(options());
  } catch (error) {
    log.warn(String((error as Error)?.message ?? error));
  }
}

/**
 * Intentionally a no-op: everything the extension owns is either disposed through context.subscriptions or
 * lives in the workspace (.cursor/) and must survive a reload. Removing workspace files is the explicit
 * "Remove from This Workspace" command; extension removal runs scripts/uninstall.js (vscode:uninstall),
 * which cleans up global storage only.
 */
export function deactivate() {}
