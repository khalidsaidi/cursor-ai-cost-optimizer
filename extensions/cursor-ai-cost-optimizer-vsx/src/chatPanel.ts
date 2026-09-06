/**
 * The cost-routed chat: a sidebar webview whose every turn runs on the model the extension picked, through the
 * Cursor CLI (same account, same bill). Each reply is shown under the name of the model that produced it, with
 * what it read, ran and changed, and what the turn cost against the same tokens at Auto's rate.
 *
 * What a chat of this kind owes its user, learned from Copilot Chat, Cline and Cursor's own forum: the reply
 * streams; a reload does not lose the conversation, and earlier ones can be reopened; the active file and
 * selection travel with the request unless switched off; an edit can be undone, one file or a whole turn; a
 * model that hits its usage limit is swapped for the next tier with one line of explanation; the model stays
 * the same across a conversation unless a request needs a stronger one; Escape stops a running turn.
 */
import * as vscode from "vscode";
import { spawn, execFile, execFileSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import {
  buildCliArgs,
  consolidateText,
  endParagraph,
  parseCliErrorLine,
  parseCliStatus,
  parseStreamLine,
  priceTurn,
  relativeTo,
  routePrompt,
  stickyRoute,
  stripOverrideTag,
  type ChatEvent,
  type Usage
} from "./chatRunner";
import { loadPricing, modelDisplayName, readTierModels, type PricingTable } from "./pricing";
import { DEFAULT_CONFIG, TIERS, type Tier } from "./scorer";
import { RepoPerTaskCheckpointService } from "./vendor/roo/services/checkpoints";
import { workspaceStateDir } from "./userScope";

interface ToolRow {
  id: string;
  tool: string;
  path: string | null;
  label: string;
  status: "started" | "completed";
  ok?: boolean;
  diff?: string | null;
  detail?: string | null;
}

interface Turn {
  id: number;
  prompt: string;
  contextNote: string | null;
  tier: Tier;
  model: string;
  modelLabel: string;
  notes: string[];
  tools: ToolRow[];
  text: string;
  thinking: boolean;
  status: "running" | "done" | "error" | "stopped";
  error?: string;
  usage?: Usage | null;
  usd?: number | null;
  atAutoRateUsd?: number;
  durationMs?: number;
  /** Shadow-git commit of the workspace taken before the turn ran (Roo Code's checkpoint service). */
  checkpoint?: string | null;
  restored?: boolean;
}

interface Conversation {
  id: string;
  workspace: string;
  title: string;
  sessionId: string | null;
  turns: Turn[];
  totalUsd: number;
  totalAtAutoRateUsd: number;
  updatedAt: string;
}

export interface ChatDeps {
  stateRoot: string;
  bundledPricing: string;
  userScope: () => boolean;
  output: vscode.OutputChannel;
}

const DEFAULT_TIER_MODELS: Record<Tier, string> = { fast: "composer-2.5", balanced: "claude-sonnet-5-medium", deep: "claude-opus-5-thinking-high" };
const HISTORY_KEY = "cco.chat.history.v1";
const HISTORY_LIMIT = 30;
const LIMIT_MINUTES = 360;

/** Where the Cursor CLI is looked for, in order: the setting, PATH, the installer's default locations. */
export function cursorAgentCandidates(configured?: string | null): string[] {
  const home = os.homedir();
  const out: string[] = [];
  if (configured && configured.trim()) {
    out.push(configured.trim());
  }
  out.push("cursor-agent", path.join(home, ".local", "bin", "cursor-agent"));
  try {
    const versions = path.join(home, ".local", "share", "cursor-agent", "versions");
    for (const v of fs.readdirSync(versions).sort().reverse()) {
      out.push(path.join(versions, v, "cursor-agent"));
    }
  } catch {
    // no versions directory
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    out.push(path.join(local, "cursor-agent", "cursor-agent.exe"), path.join(local, "Programs", "cursor-agent", "cursor-agent.exe"), "cursor-agent.cmd", "agent");
  }
  return out;
}

export function findCursorAgent(configured?: string | null): string | null {
  for (const c of cursorAgentCandidates(configured)) {
    try {
      if (c.includes(path.sep)) {
        if (fs.existsSync(c)) {
          return c;
        }
        continue;
      }
      const found = execFileSync(process.platform === "win32" ? "where" : "which", [c], { encoding: "utf8" }).trim().split("\n")[0];
      if (found) {
        return found;
      }
    } catch {
      // next candidate
    }
  }
  return null;
}

/** The plugin's cooldown file, shared with the hooks: { [model]: { until, reason, at, failures } }. */
function limitsPath(stateRoot: string): string {
  return path.join(stateRoot, "model-limits.json");
}

function modelLimitedUntil(stateRoot: string, model: string): string | null {
  try {
    const limits = JSON.parse(fs.readFileSync(limitsPath(stateRoot), "utf8")) as Record<string, { until?: string }>;
    const until = limits[model]?.until;
    return until && Date.parse(until) > Date.now() ? until : null;
  } catch {
    return null;
  }
}

function markModelLimited(stateRoot: string, model: string, reason: string): void {
  let limits: Record<string, Record<string, unknown>> = {};
  try {
    limits = JSON.parse(fs.readFileSync(limitsPath(stateRoot), "utf8")) as Record<string, Record<string, unknown>>;
  } catch {
    limits = {};
  }
  const prev = limits[model] ?? {};
  const now = new Date().toISOString();
  limits[model] = { until: new Date(Date.now() + LIMIT_MINUTES * 60_000).toISOString(), reason, at: now, failures: Number(prev.failures ?? 0) + 1, firstFailureAt: prev.firstFailureAt ?? now };
  try {
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(limitsPath(stateRoot), JSON.stringify(limits, null, 2));
  } catch {
    // best effort
  }
}

function tierName(tier: Tier): string {
  return tier === "fast" ? vscode.l10n.t("Fast") : tier === "balanced" ? vscode.l10n.t("Balanced") : vscode.l10n.t("Deep");
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "cco.chatView";
  private view: vscode.WebviewView | null = null;
  private conversation: Conversation | null = null;
  private child: ChildProcess | null = null;
  private nextTurnId = 1;
  private includeContext = true;
  private availableModels: Set<string> | null = null;
  private checkpoints: { conversationId: string; service: RepoPerTaskCheckpointService } | null = null;
  private checkpointsBroken: string | null = null;
  private setup: { cli: "checking" | "ok" | "missing" | "not_logged_in"; account: string | null; git: boolean } = { cli: "checking", account: null, git: true };

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: ChatDeps) {
    this.includeContext = vscode.workspace.getConfiguration("costOptimizer").get<boolean>("chat.includeActiveFile", true);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => this.pushState()), vscode.window.onDidChangeTextEditorSelection(() => this.pushState()));
    void this.loadAvailableModels();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media", "chat")] };
    view.webview.html = this.html(view.webview);
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post({ type: "focus" });
      }
    });
    view.webview.onDidReceiveMessage((m: { type: string; text?: string; forced?: string; path?: string; turnId?: number; toolId?: string; id?: string; include?: boolean }) => {
      switch (m.type) {
        case "ready":
          if (!this.conversation) {
            this.restoreLatest();
          }
          this.pushState();
          this.post({ type: "focus" });
          void this.checkSetup();
          break;
        case "recheck":
          void this.checkSetup();
          break;
        case "setupInstall": {
          // The official installer, run by the user in a terminal they can see (never silently).
          const term = vscode.window.createTerminal({ name: "Cursor CLI" });
          term.show();
          term.sendText(process.platform === "win32" ? "irm https://cursor.com/install -useb | iex" : "curl https://cursor.com/install -fsS | bash", false);
          break;
        }
        case "setupLogin": {
          const term = vscode.window.createTerminal({ name: "Cursor CLI login" });
          term.show();
          const bin = findCursorAgent(vscode.workspace.getConfiguration("costOptimizer").get<string>("chat.cliPath", "")) ?? "cursor-agent";
          term.sendText(`${bin.includes(" ") ? JSON.stringify(bin) : bin} login`, true);
          break;
        }
        case "send":
          void this.send(String(m.text ?? ""), (m.forced as Tier | "auto" | undefined) ?? "auto");
          break;
        case "stop":
          this.stop();
          break;
        case "new":
          this.stop();
          this.persist();
          this.conversation = null;
          this.checkpoints = null;
          this.pushState();
          this.post({ type: "focus" });
          break;
        case "context":
          this.includeContext = Boolean(m.include);
          this.pushState();
          break;
        case "restore":
          void this.restore(Number(m.turnId));
          break;
        case "history":
          this.openFromHistory(String(m.id ?? ""));
          break;
        case "historyDelete":
          this.deleteFromHistory(String(m.id ?? ""));
          break;
        case "settings":
          void vscode.commands.executeCommand("workbench.action.openSettings", "costOptimizer.chat");
          break;
        case "models":
          void vscode.commands.executeCommand("cco.chooseTierModels");
          break;
        case "open":
          if (m.path) {
            const ws = this.workspace();
            const abs = path.isAbsolute(m.path) ? m.path : path.join(ws ?? "", m.path);
            void vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
          }
          break;
      }
    });
  }

  reveal(): void {
    if (this.view) {
      this.view.show(true);
      this.post({ type: "focus" });
      return;
    }
    void vscode.commands.executeCommand("cco.chatView.focus");
  }

  // ---------- setup ----------

  /** Is the CLI there and logged in, is git there: shown as a card in the panel until it is all in order. */
  private async checkSetup(): Promise<void> {
    const bin = findCursorAgent(vscode.workspace.getConfiguration("costOptimizer").get<string>("chat.cliPath", ""));
    let git = true;
    try {
      execFileSync("git", ["--version"], { encoding: "utf8", timeout: 5000 });
    } catch {
      git = false;
    }
    if (!bin) {
      this.setup = { cli: "missing", account: null, git };
      this.pushState();
      return;
    }
    this.setup = { cli: "checking", account: null, git };
    this.pushState();
    await new Promise<void>((resolve) => {
      execFile(bin, ["status"], { timeout: 15_000, env: { ...process.env, CCO_DISABLED: "1" } }, (_err, stdout, stderr) => {
        const status = parseCliStatus(`${stdout ?? ""}\n${stderr ?? ""}`);
        this.setup = { cli: status.loggedIn ? "ok" : "not_logged_in", account: status.account, git };
        this.pushState();
        resolve();
      });
    });
  }

  // ---------- state ----------

  private workspace(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  private pricing(): PricingTable | null {
    try {
      const userPricing = path.join(this.deps.stateRoot, "pricing.json");
      return loadPricing(fs.existsSync(userPricing) ? userPricing : null, this.deps.bundledPricing);
    } catch {
      return null;
    }
  }

  private tierModels(ws: string): Record<Tier, string | null> {
    const user = this.deps.userScope();
    const read = readTierModels(ws, user ? path.join(os.homedir(), ".cursor", "agents") : undefined, user ? path.join(this.deps.stateRoot, "agent-names.json") : undefined);
    const out = { ...read };
    for (const tier of TIERS) {
      if (!out[tier] || out[tier] === "inherit") {
        out[tier] = DEFAULT_TIER_MODELS[tier];
      }
    }
    return out;
  }

  /** Tier models minus those on cooldown or not listed by the CLI for this account; what was skipped, and why. */
  private usableTierModels(ws: string): { models: Record<Tier, string | null>; skipped: string[] } {
    const models = this.tierModels(ws);
    const skipped: string[] = [];
    for (const tier of TIERS) {
      const m = models[tier];
      if (!m) {
        continue;
      }
      const until = modelLimitedUntil(this.deps.stateRoot, m);
      if (until) {
        skipped.push(vscode.l10n.t("{0} is on cooldown until {1} (usage limit)", modelDisplayName(m, this.pricing()), new Date(until).toLocaleTimeString()));
        models[tier] = null;
      } else if (this.availableModels && this.availableModels.size > 0 && !this.availableModels.has(m)) {
        skipped.push(vscode.l10n.t("{0} is not a model this account lists", modelDisplayName(m, this.pricing())));
        models[tier] = null;
      }
    }
    return { models, skipped };
  }

  private async loadAvailableModels(): Promise<void> {
    const cached = this.context.globalState.get<{ at: number; ids: string[] }>("cco.chat.models");
    if (cached && Date.now() - cached.at < 24 * 3600 * 1000) {
      this.availableModels = new Set(cached.ids);
      return;
    }
    const bin = findCursorAgent(vscode.workspace.getConfiguration("costOptimizer").get<string>("chat.cliPath", ""));
    if (!bin) {
      return;
    }
    execFile(bin, ["--list-models"], { timeout: 30_000, env: { ...process.env, CCO_DISABLED: "1" } }, (err, stdout) => {
      if (err || !stdout) {
        return;
      }
      const ids = stdout
        .split("\n")
        .map((l) => l.match(/^([a-z0-9][a-z0-9.\-]*) - /i)?.[1] ?? "")
        .filter(Boolean);
      if (ids.length) {
        this.availableModels = new Set(ids);
        void this.context.globalState.update("cco.chat.models", { at: Date.now(), ids });
      }
    });
  }

  /** The active editor's file and selection, as the request's context (Copilot's implicit context, with a switch). */
  private activeContext(ws: string): { file: string; selection: string | null; snippet: string | null } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file" || !editor.document.uri.fsPath.startsWith(ws)) {
      return null;
    }
    const file = relativeTo(editor.document.uri.fsPath, ws);
    const sel = editor.selection;
    if (sel.isEmpty) {
      return { file, selection: null, snippet: null };
    }
    const text = editor.document.getText(sel);
    return { file, selection: `${sel.start.line + 1}-${sel.end.line + 1}`, snippet: text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text };
  }

  // ---------- sending ----------

  private async send(rawText: string, forced: Tier | "auto"): Promise<void> {
    const text = rawText.trim();
    const ws = this.workspace();
    if (!text || this.child) {
      return;
    }
    if (!ws) {
      this.post({ type: "notice", text: vscode.l10n.t("Open a folder first: the chat works on a workspace.") });
      return;
    }
    const configured = vscode.workspace.getConfiguration("costOptimizer").get<string>("chat.cliPath", "");
    const bin = findCursorAgent(configured);
    if (!bin) {
      const looked = cursorAgentCandidates(configured).filter((c) => c.includes(path.sep)).join(", ");
      this.deps.output.appendLine(`[chat] cursor-agent not found; PATH=${process.env.PATH ?? ""}; looked in ${looked}`);
      this.post({ type: "notice", text: vscode.l10n.t("The Cursor CLI (cursor-agent) was not found on this machine's PATH or in {0}. If it is installed elsewhere, set its path in Settings (costOptimizer.chat.cliPath). To install: `curl https://cursor.com/install -fsS | bash`, then `cursor-agent login`.", looked) });
      return;
    }
    if (!this.conversation || this.conversation.workspace !== ws) {
      this.persist();
      this.conversation = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, workspace: ws, title: text.slice(0, 60), sessionId: null, turns: [], totalUsd: 0, totalAtAutoRateUsd: 0, updatedAt: new Date().toISOString() };
    }
    const pricing = this.pricing();
    const usable = this.usableTierModels(ws);
    const routed = routePrompt({ prompt: text, tierModels: usable.models, forced, config: DEFAULT_CONFIG });
    if (!routed) {
      this.post({ type: "notice", text: vscode.l10n.t("No tier model can run right now ({0}). Choose tier models from the status bar menu.", usable.skipped.join("; ") || vscode.l10n.t("none set up")) });
      return;
    }
    const previous = [...this.conversation.turns].reverse().find((t) => t.status === "done") ?? null;
    const route = stickyRoute(previous ? { tier: previous.tier, model: previous.model } : null, routed);
    const notes: string[] = [];
    if (route.fallbackFrom) {
      notes.push(vscode.l10n.t("The {0} tier's model cannot run right now ({1}), so this runs on the {2} tier's model.", tierName(route.fallbackFrom), usable.skipped.join("; "), tierName(route.tier)));
    }
    if (route.decision.guardrail && /risk/.test(route.decision.guardrail)) {
      notes.push(vscode.l10n.t("Risky work: sent to a stronger tier."));
    }
    if (route.kept && previous && previous.model !== routed.model) {
      notes.push(vscode.l10n.t("Kept on {0}: switching models mid-conversation re-reads the whole context on the new model.", modelDisplayName(previous.model, pricing)));
    } else if (previous && previous.model !== route.model) {
      notes.push(vscode.l10n.t("Moved up from {0}: this request needs the {1} tier.", modelDisplayName(previous.model, pricing), tierName(route.tier)));
    }
    const ctx = this.includeContext ? this.activeContext(ws) : null;
    const contextNote = ctx ? (ctx.selection ? vscode.l10n.t("with {0} lines {1}", ctx.file, ctx.selection) : vscode.l10n.t("with {0}", ctx.file)) : null;
    const promptForModel = ctx
      ? `${stripOverrideTag(text)}\n\nContext: the user has ${ctx.file} open${ctx.selection ? ` with lines ${ctx.selection} selected` : ""}.${ctx.snippet ? `\nSelected text:\n\`\`\`\n${ctx.snippet}\n\`\`\`` : ""}`
      : stripOverrideTag(text);

    const turn: Turn = { id: this.nextTurnId++, prompt: text, contextNote, tier: route.tier, model: route.model, modelLabel: modelDisplayName(route.model, pricing), notes, tools: [], text: "", thinking: false, status: "running" };
    this.conversation.turns.push(turn);
    this.pushState();
    turn.checkpoint = await this.saveCheckpoint(this.conversation, turn.id);
    this.pushState();
    await this.run(bin, ws, turn, promptForModel, pricing, 0);
  }

  private async run(bin: string, ws: string, turn: Turn, promptForModel: string, pricing: PricingTable | null, attempt: number): Promise<void> {
    const conversation = this.conversation as Conversation;
    const commands = vscode.workspace.getConfiguration("costOptimizer").get<"auto-review" | "force" | "none">("chat.runCommands", "auto-review");
    const args = buildCliArgs({ model: turn.model, prompt: promptForModel, resume: conversation.sessionId, commands });
    args.splice(3, 0, "--stream-partial-output");
    this.deps.output.appendLine(`[chat] ${bin} ${args.slice(0, -1).join(" ")} <prompt ${promptForModel.length} chars> (cwd ${ws})`);
    const child = spawn(bin, args, { cwd: ws, env: { ...process.env, CCO_DISABLED: "1", CCO_PANEL: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let stderr = "";
    let cliError: ReturnType<typeof parseCliErrorLine> = null;
    let segment = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const rl = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
    rl.on("line", (line) => {
      const ev = parseStreamLine(line, ws);
      if (!ev) {
        const err = parseCliErrorLine(line);
        if (err) {
          cliError = err;
        }
        return;
      }
      if (ev.kind === "text") {
        const c = consolidateText(segment, ev.text);
        segment = c.segment;
        turn.thinking = false;
        if (c.append) {
          turn.text += c.append;
        } else {
          turn.text = endParagraph(turn.text); // the segment is complete: what follows is a new paragraph
        }
        this.pushState();
        return;
      }
      if (ev.kind === "tool") {
        segment = "";
        turn.text = endParagraph(turn.text);
      }
      this.onEvent(conversation, turn, ev, pricing);
    });
    child.on("close", (code) => {
      this.child = null;
      if (turn.status === "running") {
        turn.thinking = false;
        const limit = cliError?.kind === "usage_limit" || /usage limit|ActionRequiredError/i.test(stderr);
        if (limit && attempt < TIERS.length) {
          // The model is out of budget on this plan: remember that for a few hours (the hooks read the same
          // file) and run this turn again on the next tier that can, saying so.
          markModelLimited(this.deps.stateRoot, turn.model, "usage_limit");
          const again = this.usableTierModels(ws);
          const order: Tier[] = [...TIERS.slice(TIERS.indexOf(turn.tier) + 1), ...TIERS.slice(0, TIERS.indexOf(turn.tier)).reverse()];
          const next = order.map((t) => ({ tier: t, model: again.models[t] })).find((x) => x.model);
          if (next && next.model) {
            turn.notes.push(vscode.l10n.t("{0} has hit its usage limit on this plan; running on {1} ({2} tier) instead.", turn.modelLabel, modelDisplayName(next.model, pricing), tierName(next.tier)));
            turn.tier = next.tier;
            turn.model = next.model;
            turn.modelLabel = modelDisplayName(next.model, pricing);
            turn.tools = [];
            turn.text = "";
            this.pushState();
            void this.run(bin, ws, turn, promptForModel, pricing, attempt + 1);
            return;
          }
        }
        turn.status = code === 0 && !cliError ? "done" : "error";
        if (turn.status === "error") {
          turn.error = cliError?.message || stderr.trim().split("\n").slice(-3).join("\n") || vscode.l10n.t("The Cursor CLI exited with code {0}.", String(code));
          if (cliError?.kind === "not_logged_in" || /not logged in|login|unauthorized|401/i.test(stderr)) {
            turn.error = vscode.l10n.t("The Cursor CLI is not logged in: run `cursor-agent login` in a terminal, then try again.");
          } else if (limit) {
            turn.error = vscode.l10n.t("{0}: no other tier model can run right now ({1}).", turn.error, this.usableTierModels(ws).skipped.join("; "));
          }
        }
      }
      this.persist();
      this.pushState();
    });
    child.on("error", (err) => {
      this.child = null;
      turn.status = "error";
      turn.error = String(err.message || err);
      this.persist();
      this.pushState();
    });
  }

  private onEvent(conversation: Conversation, turn: Turn, ev: ChatEvent, pricing: PricingTable | null): void {
    switch (ev.kind) {
      case "init":
        if (ev.sessionId) {
          conversation.sessionId = ev.sessionId;
        }
        break;
      case "thinking":
        turn.thinking = true;
        break;
      case "tool": {
        turn.thinking = false;
        const existing = turn.tools.find((t) => t.id === ev.id);
        if (existing) {
          existing.status = ev.status;
          existing.ok = ev.ok;
          existing.diff = ev.diff ?? null;
          existing.detail = ev.detail ?? null;
          existing.path = ev.path ?? existing.path;
          if (ev.label.trim()) {
            existing.label = ev.label;
          }
        } else {
          turn.tools.push({ id: ev.id, tool: ev.tool, path: ev.path ?? null, label: ev.label, status: ev.status, ok: ev.ok, diff: ev.diff ?? null, detail: ev.detail ?? null });
        }
        break;
      }
      case "result": {
        if (ev.sessionId) {
          conversation.sessionId = ev.sessionId;
        }
        if (ev.text && !turn.text) {
          turn.text = ev.text;
        }
        turn.thinking = false;
        turn.status = ev.ok ? "done" : "error";
        turn.durationMs = ev.durationMs;
        turn.usage = ev.usage;
        if (ev.usage) {
          const cost = priceTurn(ev.usage, turn.model, pricing);
          turn.usd = cost.usd;
          turn.atAutoRateUsd = cost.atAutoRateUsd;
          conversation.totalUsd += cost.usd ?? 0;
          conversation.totalAtAutoRateUsd += cost.atAutoRateUsd;
          this.recordDecision(conversation, turn);
        }
        break;
      }
      case "text":
        break;
    }
    this.pushState();
  }

  private stop(): void {
    if (this.child) {
      const turn = this.conversation?.turns[this.conversation.turns.length - 1];
      if (turn && turn.status === "running") {
        turn.status = "stopped";
        turn.thinking = false;
        if (turn.tools.some((t) => t.diff)) {
          turn.notes.push(vscode.l10n.t("Stopped. The edits made so far are in your files; Restore puts them back."));
        }
      }
      try {
        this.child.kill("SIGTERM");
      } catch {
        // already gone
      }
      this.child = null;
      this.persist();
      this.pushState();
    }
  }

  /**
   * One line in the same decisions log the hooks write, so the status bar shows one savings figure and names the
   * panel's run as the last task. `chatEstimateUsd` is the same tokens at Auto's billed rate.
   */
  private recordDecision(conversation: Conversation, turn: Turn): void {
    try {
      const dir = this.deps.userScope() ? path.join(workspaceStateDir(this.deps.stateRoot, conversation.workspace), "state") : path.join(conversation.workspace, ".cursor", "cco", "state");
      fs.mkdirSync(dir, { recursive: true });
      const line = { ts: new Date().toISOString(), conversation_id: conversation.id, source: "panel", requested: "chat-panel", final: `${turn.model}-${turn.tier}`, model: turn.model, tier: turn.tier, rewritten: false, reason: "chat_panel", estimateUsd: turn.usd ?? null, chatEstimateUsd: turn.atAutoRateUsd ?? null, usage: turn.usage ?? null };
      fs.appendFileSync(path.join(dir, "decisions.jsonl"), `${JSON.stringify(line)}\n`);
    } catch (err) {
      this.deps.output.appendLine(`[chat] could not record the decision: ${String((err as Error).message || err)}`);
    }
  }

  // ---------- checkpoints (Roo Code's shadow-git service, vendored) ----------

  /** The shadow repository for this conversation: created on first use, kept for the conversation's life. */
  private async checkpointService(conversation: Conversation): Promise<RepoPerTaskCheckpointService | null> {
    if (!vscode.workspace.getConfiguration("costOptimizer").get<boolean>("chat.checkpoints", true) || this.checkpointsBroken) {
      return null;
    }
    if (this.checkpoints?.conversationId === conversation.id) {
      return this.checkpoints.service;
    }
    try {
      const service = RepoPerTaskCheckpointService.create({ taskId: conversation.id, workspaceDir: conversation.workspace, shadowDir: this.context.globalStorageUri.fsPath, log: (m) => this.deps.output.appendLine(`[checkpoints] ${m}`) });
      await service.initShadowGit();
      this.checkpoints = { conversationId: conversation.id, service };
      return service;
    } catch (err) {
      this.checkpointsBroken = String((err as Error).message || err);
      this.deps.output.appendLine(`[checkpoints] unavailable: ${this.checkpointsBroken}`);
      return null;
    }
  }

  private async saveCheckpoint(conversation: Conversation, turnId: number): Promise<string | null> {
    const service = await this.checkpointService(conversation);
    if (!service) {
      return null;
    }
    try {
      const result = await service.saveCheckpoint(`before turn ${turnId}`, { allowEmpty: true, suppressMessage: true });
      return result?.commit ?? service.getCheckpoints().slice(-1)[0] ?? service.baseHash ?? null;
    } catch (err) {
      this.deps.output.appendLine(`[checkpoints] save failed: ${String((err as Error).message || err)}`);
      return null;
    }
  }

  /** Put the workspace back as it was before a turn ran: `git clean` + `git reset --hard` in the shadow repo. */
  private async restore(turnId: number): Promise<void> {
    const conversation = this.conversation;
    const turn = conversation?.turns.find((t) => t.id === turnId);
    if (!conversation || !turn || !turn.checkpoint) {
      return;
    }
    const service = await this.checkpointService(conversation);
    if (!service) {
      this.post({ type: "notice", text: vscode.l10n.t("Checkpoints are not available here ({0}). Use Source Control to restore files.", this.checkpointsBroken ?? "off") });
      return;
    }
    // The confirmation is in the panel itself (two clicks, Cline's pattern): no native dialog to hunt for.
    try {
      await service.restoreCheckpoint(turn.checkpoint);
      turn.restored = true;
      for (const t of conversation.turns) {
        if (t.id > turn.id) {
          t.restored = true;
        }
      }
      this.persist();
      this.pushState();
    } catch (err) {
      this.post({ type: "notice", text: vscode.l10n.t("Restore failed: {0}", String((err as Error).message || err)) });
    }
  }

  // ---------- history ----------

  private history(): Conversation[] {
    return this.context.globalState.get<Conversation[]>(HISTORY_KEY, []);
  }

  private persist(): void {
    const c = this.conversation;
    if (!c || !c.turns.length) {
      return;
    }
    c.updatedAt = new Date().toISOString();
    const rest = this.history().filter((h) => h.id !== c.id);
    const next = [c, ...rest].slice(0, HISTORY_LIMIT);
    for (const dropped of rest.slice(HISTORY_LIMIT - 1)) {
      this.removeCheckpointRepo(dropped.id);
    }
    void this.context.globalState.update(HISTORY_KEY, next);
  }

  private restoreLatest(): void {
    const ws = this.workspace();
    const latest = this.history().find((h) => h.workspace === ws);
    if (latest) {
      this.conversation = latest;
      this.nextTurnId = Math.max(0, ...latest.turns.map((t) => t.id)) + 1;
      for (const t of latest.turns) {
        if (t.status === "running") {
          t.status = "stopped";
        }
      }
    }
  }

  private openFromHistory(id: string): void {
    this.stop();
    this.persist();
    const found = this.history().find((h) => h.id === id);
    if (found) {
      this.conversation = found;
      this.nextTurnId = Math.max(0, ...found.turns.map((t) => t.id)) + 1;
    }
    this.pushState();
    this.post({ type: "focus" });
  }

  private deleteFromHistory(id: string): void {
    void this.context.globalState.update(HISTORY_KEY, this.history().filter((h) => h.id !== id));
    if (this.conversation?.id === id) {
      this.conversation = null;
      this.checkpoints = null;
    }
    this.removeCheckpointRepo(id);
    this.pushState();
  }

  /** A conversation's shadow repository holds a copy of the workspace's tracked files: it goes when the conversation does. */
  private removeCheckpointRepo(id: string): void {
    try {
      fs.rmSync(path.join(this.context.globalStorageUri.fsPath, "tasks", id), { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  // ---------- webview ----------

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private pushState(): void {
    const c = this.conversation;
    const ws = this.workspace();
    const sum = (k: keyof Usage) => (c?.turns ?? []).reduce((acc, t) => acc + (t.usage?.[k] ?? 0), 0);
    const ctx = ws ? this.activeContext(ws) : null;
    this.post({
      type: "state",
      running: Boolean(this.child),
      workspace: ws ? path.basename(ws) : "",
      conversationId: c?.id ?? null,
      setup: this.setup,
      folders: (vscode.workspace.workspaceFolders ?? []).length,
      checkpointsAvailable: !this.checkpointsBroken && this.setup.git && vscode.workspace.getConfiguration("costOptimizer").get<boolean>("chat.checkpoints", true),
      checkpointsReason: !vscode.workspace.getConfiguration("costOptimizer").get<boolean>("chat.checkpoints", true) ? "off in Settings" : !this.setup.git ? "git is not installed" : this.checkpointsBroken,
      context: { include: this.includeContext, file: ctx?.file ?? null, selection: ctx?.selection ?? null },
      history: this.history()
        .filter((h) => h.workspace === ws)
        .map((h) => ({ id: h.id, title: h.title, updatedAt: h.updatedAt, turns: h.turns.length, usd: h.totalUsd })),
      totals: c ? { usd: c.totalUsd, atAutoRateUsd: c.totalAtAutoRateUsd, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens"), turns: c.turns.filter((t) => t.usage).length } : null,
      turns: (c?.turns ?? []).map((t) => ({
        id: t.id,
        prompt: t.prompt,
        contextNote: t.contextNote,
        tier: t.tier,
        model: t.model,
        modelLabel: t.modelLabel,
        notes: t.notes,
        status: t.status,
        thinking: t.thinking,
        error: t.error ?? null,
        text: t.text,
        tools: t.tools.map((tool) => ({ id: tool.id, tool: tool.tool, label: tool.label, path: tool.path, status: tool.status, ok: tool.ok ?? null, diff: tool.diff ?? null, detail: tool.detail ?? null })),
        checkpoint: t.checkpoint ?? null,
        restored: Boolean(t.restored),
        usage: t.usage ?? null,
        usd: t.usd ?? null,
        atAutoRateUsd: t.atAutoRateUsd ?? null,
        seconds: t.durationMs ? Math.round(t.durationMs / 1000) : null
      }))
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const base = vscode.Uri.joinPath(this.context.extensionUri, "media", "chat");
    // The webview's service worker caches resources by URL: a version stamp makes an updated bundle load after
    // an install (measured: a remote window kept the previous panel for a whole session without it).
    let stamp = String(this.context.extension.packageJSON?.version ?? "");
    try {
      stamp += `-${Math.floor(fs.statSync(path.join(base.fsPath, "index.js")).mtimeMs)}`;
    } catch {
      // keep the version alone
    }
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, "index.js")).with({ query: `v=${stamp}` });
    const style = webview.asWebviewUri(vscode.Uri.joinPath(base, "index.css")).with({ query: `v=${stamp}` });
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Cost-routed chat</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${script}"></script>
</body>
</html>`;
  }
}
