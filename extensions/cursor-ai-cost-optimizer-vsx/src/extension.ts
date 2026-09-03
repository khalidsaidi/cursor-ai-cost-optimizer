import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decideHookMode, doctorWorkspace, findBundledBinary, findNode, installWorkspace, plannedFiles, uninstallWorkspace, workspacePaths, workspaceStatus, type HookRuntimePreference, type Options } from "./install";
import { costStatement, formatUsd, readSavings } from "./pricing";
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

  // ---- status bar: "AI Cost" (+ $(warning) when pricing is stale or a tier is inherit); click opens the menu ----
  const status = vscode.window.createStatusBarItem("cco.status", vscode.StatusBarAlignment.Right, 100);
  status.name = "AI Cost Optimizer";
  status.command = "cco.showMenu";
  context.subscriptions.push(status);
  const refreshStatus = () => {
    const ws = firstWorkspace();
    if (!ws) {
      status.hide();
      return;
    }
    const s = workspaceStatus(ws);
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**AI Cost Optimizer** — ${s.enabled ? "active" : `inactive (${s.reason ?? "not installed"})`} in \`${path.basename(ws)}\` · hooks: ${s.hookMode ?? "not installed"}\n\n`);
    let warn = false;
    if (s.installed) {
      const cost = costStatement(ws, bundledPricing);
      for (const line of cost.lines) {
        md.appendMarkdown(`- ${line.text}\n`);
      }
      const savings = readSavings(ws);
      md.appendMarkdown(`\nest. savings ${formatUsd(savings.savedUsd)} in this project (${savings.decisions} routed task${savings.decisions === 1 ? "" : "s"}, est. ${formatUsd(savings.estimatedUsd)} spent on tiers)\n`);
      if (cost.warnings.length) {
        warn = true;
        md.appendMarkdown(`\n$(warning) ${cost.warnings.join("; ")} — run \`/cco-init\` in a new chat\n`);
      }
      if (!cost.chatModel) {
        md.appendMarkdown(`\n_Rates relative to your chat model appear after the first chat in this project._\n`);
      }
    } else {
      md.appendMarkdown(`Not set up in this project yet. [Set up for this workspace](command:cco.installCursorAssets)\n`);
    }
    status.text = warn ? "$(warning) AI Cost" : s.installed ? (s.enabled ? "$(zap) AI Cost" : "$(zap) AI Cost: off") : "$(zap) AI Cost";
    status.tooltip = md;
    status.show();
  };
  refreshStatus();
  const watcher = vscode.workspace.createFileSystemWatcher("**/.cursor/{cco.json,hooks.json,agents/cco-*.md,cco/pricing.json,cco/state/decisions.jsonl,cco/state/sessions/*.json}");
  context.subscriptions.push(watcher, watcher.onDidChange(refreshStatus), watcher.onDidCreate(refreshStatus), watcher.onDidDelete(refreshStatus));

  // ---- doctor on activation ----
  const runDoctor = () => {
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
  const installCmd = vscode.commands.registerCommand("cco.installCursorAssets", async (args?: { confirm?: boolean; workspace?: string }) => {
    const ws = args?.workspace ?? (await pickWorkspace("set up"));
    if (!ws) {
      if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
        void notify("error", "AI Cost Optimizer: open a folder first.");
      }
      return;
    }
    try {
      const opts = options();
      const plan = plannedFiles(ws, opts);
      if (args?.confirm !== false) {
        const detail = [`Creates:`, ...plan.creates.map((f) => `  ${f}`), ``, `Modifies:`, ...plan.modifies.map((f) => `  ${f}`), ``, `Hook runtime: ${plan.hookMode === "binary" ? "bundled cco-hook binary (no Node.js needed)" : "node .cursor/cco-hook.mjs (Node.js >= 18 on PATH)"}`, `Nothing is written outside ${ws}.`].join("\n");
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
      const tiers = Object.entries(result.agents).map(([k, v]) => `${k.replace("cco-", "")} → ${v ?? "?"}`).join(", ");
      log.info(`[install] tiers: ${tiers}`);
      void vscode.window.showInformationMessage(`AI Cost Optimizer is set up for ${path.basename(ws)}. Start a new chat to use it.`, "Show details").then((choice) => {
        if (choice === "Show details") {
          log.show(true);
        }
      });
      return result;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      log.error(`[install] ${ws}: ${message}`);
      void notify("error", `AI Cost Optimizer install failed: ${message.split("\n")[0]}`);
    }
  });

  const uninstallCmd = vscode.commands.registerCommand("cco.uninstallCursorAssets", async (args?: { confirm?: boolean; workspace?: string }) => {
    const ws = args?.workspace ?? (await pickWorkspace("remove AI Cost Optimizer from"));
    if (!ws) {
      if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
        void notify("error", "AI Cost Optimizer: open a folder first.");
      }
      return;
    }
    if (args?.confirm !== false) {
      const choice = await vscode.window.showWarningMessage(`Remove AI Cost Optimizer from ${path.basename(ws)}/.cursor/?`, { modal: true, detail: "Removes CCO's hook entries, the generated cco-* subagents, the rule/skills/commands it added, and its state folder. Your own files and other tools' hook entries are kept." }, "Remove");
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
      void notify("error", `AI Cost Optimizer uninstall failed: ${message.split("\n")[0]}`);
    }
  });

  const showLogCmd = vscode.commands.registerCommand("cco.showOutputChannel", () => log.show(true));

  // Status bar click: a small menu, like the Copilot status item.
  const menuCmd = vscode.commands.registerCommand("cco.showMenu", async () => {
    const ws = firstWorkspace();
    const s = ws ? workspaceStatus(ws) : null;
    const items: Array<vscode.QuickPickItem & { run: () => unknown }> = [];
    if (!s?.installed) {
      items.push({ label: "$(zap) Set up for this workspace", description: "writes only inside .cursor/", run: () => vscode.commands.executeCommand("cco.installCursorAssets") });
    } else {
      items.push({ label: "$(graph) Tier rates and savings", description: "what each tier costs relative to your chat model", run: () => vscode.commands.executeCommand("cco.recommendTier") });
      items.push({ label: "$(sync) Update setup", description: "re-run model discovery and refresh files", run: () => vscode.commands.executeCommand("cco.installCursorAssets") });
      items.push({ label: "$(trash) Remove from this workspace", run: () => vscode.commands.executeCommand("cco.uninstallCursorAssets") });
    }
    items.push({ label: "$(output) Show log", run: () => log.show(true) });
    items.push({ label: "$(bug) Copy diagnostics", run: () => vscode.commands.executeCommand("cco.collectDiagnostics") });
    items.push({ label: "$(book) Getting started", run: () => vscode.commands.executeCommand("workbench.action.openWalkthrough", `${EXTENSION_ID}#cco.gettingStarted`, false) });
    const choice = await vscode.window.showQuickPick(items, { placeHolder: s?.installed ? `AI Cost Optimizer is ${s.enabled ? "active" : "off"} in ${path.basename(ws as string)}` : "AI Cost Optimizer" });
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
      const cost = ws ? costStatement(ws, bundledPricing) : null;
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
      const cost = ws && s?.installed ? costStatement(ws, bundledPricing) : null;
      const report = [
        `## AI Cost Optimizer diagnostics`,
        `- extension: ${extensionVersion} (${vscode.env.appName} ${vscode.version}, ${process.platform}-${process.arch}, ${os.release()})`,
        `- settings: hookRuntime=${settings().hookRuntime} nodePath=${settings().nodePath ?? "(default)"}`,
        `- bundled binary: ${bundledBinary ? "yes" : "no"}; node: ${node ? `${node.label} ${nodeVersion ?? ""}`.trim() : "none"}`,
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

  context.subscriptions.push(installCmd, uninstallCmd, showLogCmd, menuCmd, recommendCmd, insertFast, insertBal, insertDeep, diagCmd);

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
