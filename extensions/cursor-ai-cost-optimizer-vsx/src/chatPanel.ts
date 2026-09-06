/**
 * The cost-routed chat: a sidebar webview whose every turn runs on the model the extension picked, through the
 * Cursor CLI (same account, same bill). Each reply is shown under the name of the model that produced it, with
 * what it read, ran and changed, and what the turn cost against the same tokens at Auto's rate.
 */
import * as vscode from "vscode";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { buildCliArgs, parseStreamLine, priceTurn, routePrompt, stripOverrideTag, type ChatEvent, type Usage } from "./chatRunner";
import { loadPricing, modelDisplayName, readTierModels, type PricingTable } from "./pricing";
import { DEFAULT_CONFIG, type Tier } from "./scorer";

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
  tier: Tier;
  model: string;
  modelLabel: string;
  guardrail: string | null;
  fallbackFrom: Tier | null;
  tools: ToolRow[];
  text: string;
  status: "running" | "done" | "error" | "stopped";
  error?: string;
  usage?: Usage | null;
  usd?: number | null;
  atAutoRateUsd?: number;
  durationMs?: number;
}

interface Conversation {
  workspace: string;
  sessionId: string | null;
  turns: Turn[];
  totalUsd: number;
  totalAtAutoRateUsd: number;
}

export interface ChatDeps {
  stateRoot: string;
  bundledPricing: string;
  userScope: () => boolean;
  output: vscode.OutputChannel;
}

const DEFAULT_TIER_MODELS: Record<Tier, string> = { fast: "composer-2.5", balanced: "claude-sonnet-5-medium", deep: "claude-opus-5-thinking-high" };

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
  const candidates = cursorAgentCandidates(configured);
  for (const c of candidates) {
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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "cco.chatView";
  private view: vscode.WebviewView | null = null;
  private conversation: Conversation | null = null;
  private child: ChildProcess | null = null;
  private nextTurnId = 1;

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: ChatDeps) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media", "chat")] };
    view.webview.html = this.html(view.webview);
    // Opening the view puts the caret in its input, as Copilot's and Cline's do.
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post({ type: "focus" });
      }
    });
    view.webview.onDidReceiveMessage((m: { type: string; text?: string; forced?: string; path?: string }) => {
      switch (m.type) {
        case "ready":
          this.pushState();
          this.post({ type: "focus" });
          break;
        case "send":
          void this.send(String(m.text ?? ""), (m.forced as Tier | "auto" | undefined) ?? "auto");
          break;
        case "stop":
          this.stop();
          break;
        case "new":
          this.stop();
          this.conversation = null;
          this.pushState();
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
    for (const tier of ["fast", "balanced", "deep"] as Tier[]) {
      if (!out[tier] || out[tier] === "inherit") {
        out[tier] = DEFAULT_TIER_MODELS[tier];
      }
    }
    return out;
  }

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
      this.conversation = { workspace: ws, sessionId: null, turns: [], totalUsd: 0, totalAtAutoRateUsd: 0 };
    }
    const pricing = this.pricing();
    const route = routePrompt({ prompt: text, tierModels: this.tierModels(ws), forced, config: DEFAULT_CONFIG });
    if (!route) {
      this.post({ type: "notice", text: vscode.l10n.t("No tier model is set up. Choose tier models from the status bar menu first.") });
      return;
    }
    const turn: Turn = {
      id: this.nextTurnId++,
      prompt: text,
      tier: route.tier,
      model: route.model,
      modelLabel: modelDisplayName(route.model, pricing),
      guardrail: route.decision.guardrail,
      fallbackFrom: route.fallbackFrom,
      tools: [],
      text: "",
      status: "running"
    };
    this.conversation.turns.push(turn);
    this.pushState();

    const commands = vscode.workspace.getConfiguration("costOptimizer").get<"auto-review" | "force" | "none">("chat.runCommands", "auto-review");
    const args = buildCliArgs({ model: route.model, prompt: stripOverrideTag(text), resume: this.conversation.sessionId, commands });
    this.deps.output.appendLine(`[chat] ${bin} ${args.slice(0, -1).join(" ")} <prompt ${text.length} chars> (cwd ${ws})`);
    // CCO_DISABLED: the routing hooks stay out of a session the panel already routed.
    const child = spawn(bin, args, { cwd: ws, env: { ...process.env, CCO_DISABLED: "1", CCO_PANEL: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const conversation = this.conversation;
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const rl = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
    rl.on("line", (line) => this.onEvent(conversation, turn, parseStreamLine(line, ws), pricing));
    child.on("close", (code) => {
      this.child = null;
      if (turn.status === "running") {
        turn.status = code === 0 ? "done" : "error";
        if (code !== 0) {
          turn.error = stderr.trim().split("\n").slice(-3).join("\n") || vscode.l10n.t("The Cursor CLI exited with code {0}.", String(code));
          if (/not logged in|login|unauthorized|401/i.test(stderr)) {
            turn.error = vscode.l10n.t("The Cursor CLI is not logged in: run `cursor-agent login` in a terminal, then try again.");
          }
        }
      }
      this.pushState();
    });
    child.on("error", (err) => {
      this.child = null;
      turn.status = "error";
      turn.error = String(err.message || err);
      this.pushState();
    });
  }

  private onEvent(conversation: Conversation, turn: Turn, ev: ChatEvent | null, pricing: PricingTable | null): void {
    if (!ev) {
      return;
    }
    switch (ev.kind) {
      case "init":
        if (ev.sessionId) {
          conversation.sessionId = ev.sessionId;
        }
        break;
      case "text":
        turn.text = turn.text ? `${turn.text}\n\n${ev.text}` : ev.text;
        break;
      case "tool": {
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
        turn.status = ev.ok ? "done" : "error";
        turn.durationMs = ev.durationMs;
        turn.usage = ev.usage;
        if (ev.usage) {
          const cost = priceTurn(ev.usage, turn.model, pricing);
          turn.usd = cost.usd;
          turn.atAutoRateUsd = cost.atAutoRateUsd;
          conversation.totalUsd += cost.usd ?? 0;
          conversation.totalAtAutoRateUsd += cost.atAutoRateUsd;
        }
        break;
      }
      case "thinking":
        break;
    }
    this.pushState();
  }

  private stop(): void {
    if (this.child) {
      const turn = this.conversation?.turns[this.conversation.turns.length - 1];
      if (turn && turn.status === "running") {
        turn.status = "stopped";
      }
      try {
        this.child.kill("SIGTERM");
      } catch {
        // already gone
      }
      this.child = null;
      this.pushState();
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private pushState(): void {
    const c = this.conversation;
    const sum = (k: keyof Usage) => (c?.turns ?? []).reduce((acc, t) => acc + (t.usage?.[k] ?? 0), 0);
    this.post({
      type: "state",
      running: Boolean(this.child),
      workspace: this.workspace() ? path.basename(this.workspace() as string) : "",
      totals: c ? { usd: c.totalUsd, atAutoRateUsd: c.totalAtAutoRateUsd, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens"), turns: c.turns.filter((t) => t.usage).length } : null,
      turns: (c?.turns ?? []).map((t) => ({
        id: t.id,
        prompt: t.prompt,
        tier: t.tier,
        model: t.model,
        modelLabel: t.modelLabel,
        guardrail: t.guardrail,
        fallbackFrom: t.fallbackFrom,
        status: t.status,
        error: t.error ?? null,
        text: t.text,
        tools: t.tools.map((tool) => ({ id: tool.id, tool: tool.tool, label: tool.label, path: tool.path, status: tool.status, ok: tool.ok ?? null, diff: tool.diff ?? null, detail: tool.detail ?? null })),
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
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, "index.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(base, "index.css"));
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
