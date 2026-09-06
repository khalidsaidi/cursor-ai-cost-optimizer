/**
 * The cost-routed chat panel's engine, kept free of VS Code so it can be unit-tested: how a prompt is routed to a
 * tier and its model, how the Cursor CLI is invoked, how its stream-json output becomes UI events, and how a turn
 * is priced from the usage the CLI reports.
 *
 * Why the CLI: Cursor's own chat panel is closed UI whose picker names the chat model whatever ran, and the chat
 * model paraphrases a subagent's reply. `cursor-agent` is logged into the same account and bills the same plan, so
 * the panel can pick the model per task itself, run it directly (no chat paying to dispatch and relay), and show
 * every reply under the name of the model that produced it.
 */
import { AUTO_RATE, resolveModelPrice, type PricingTable, type ResolvedPrice } from "./pricing";
import { decideTier, heuristicScores, parseOverride, TIERS, type ScorerConfig, type Tier, type TierDecision } from "./scorer";

export interface RouteInput {
  prompt: string;
  tierModels: Record<Tier, string | null>;
  forced?: Tier | "auto" | null;
  config?: ScorerConfig;
}

export interface Route {
  tier: Tier;
  model: string;
  decision: TierDecision;
  /** The tier actually used when the decided tier has no model set up (falls back upward, then downward). */
  fallbackFrom: Tier | null;
}

/** Route one prompt: the same scorer and guardrails the hooks use, then the tier's model. */
export function routePrompt(input: RouteInput): Route | null {
  const override = input.forced && input.forced !== "auto" ? input.forced : parseOverride(input.prompt);
  const decision = decideTier({ scores: heuristicScores(input.prompt), override, config: input.config });
  const order = [decision.tier, ...TIERS.slice(TIERS.indexOf(decision.tier) + 1), ...TIERS.slice(0, TIERS.indexOf(decision.tier)).reverse()];
  for (const tier of order) {
    const model = input.tierModels[tier];
    if (model && model !== "inherit") {
      return { tier, model, decision, fallbackFrom: tier === decision.tier ? null : decision.tier };
    }
  }
  return null;
}

/** Strip the routing tag from what the model is sent (it was read; the model need not see it). */
export function stripOverrideTag(prompt: string): string {
  return prompt.replace(/\[cco:(fast|balanced|deep|auto|off)\]\s*/gi, "").trim();
}

export interface CliArgsInput {
  model: string;
  prompt: string;
  resume?: string | null;
  /** "auto-review": safe commands run, the rest are declined; "force": every command runs; "none": no commands. */
  commands?: "auto-review" | "force" | "none";
}

export function buildCliArgs(input: CliArgsInput): string[] {
  const args = ["-p", "--output-format", "stream-json", "--trust", "--model", input.model];
  if (input.commands === "force") {
    args.push("--force");
  } else if (input.commands !== "none") {
    args.push("--auto-review");
  }
  if (input.resume) {
    args.push("--resume", input.resume);
  }
  args.push(input.prompt);
  return args;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type ChatEvent =
  | { kind: "init"; sessionId: string; model: string }
  | { kind: "text"; text: string }
  | { kind: "thinking" }
  | { kind: "tool"; id: string; tool: string; label: string; path?: string | null; status: "started" | "completed"; ok?: boolean; diff?: string | null; detail?: string | null }
  | { kind: "result"; ok: boolean; text: string; usage: Usage | null; durationMs: number; sessionId: string | null };

const TOOL_LABELS: Record<string, string> = {
  readToolCall: "Read",
  globToolCall: "Find files",
  grepToolCall: "Search",
  lsToolCall: "List",
  editToolCall: "Edit",
  writeToolCall: "Write",
  deleteToolCall: "Delete",
  shellToolCall: "Run",
  taskToolCall: "Subagent",
  webSearchToolCall: "Web search",
  fetchToolCall: "Fetch",
  semanticSearchToolCall: "Search code",
  readLintsToolCall: "Check lints",
  listDirToolCall: "List",
  todoWriteToolCall: "Plan",
  updateTodosToolCall: "Plan",
  mcpToolCall: "Tool"
};

function shortPath(p: unknown): string {
  const s = String(p || "");
  const parts = s.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : s;
}

/** A path shown to the user: relative to the workspace when inside it, otherwise its last two segments. */
export function relativeTo(p: string, workspace?: string): string {
  if (typeof workspace === "string" && workspace) {
    const root = workspace.endsWith("/") ? workspace : `${workspace}/`;
    if (p.startsWith(root)) {
      return p.slice(root.length);
    }
  }
  return shortPath(p);
}

function describeArgs(tool: string, args: Record<string, unknown>, workspace?: string): string {
  switch (tool) {
    case "readToolCall":
    case "editToolCall":
    case "writeToolCall":
    case "deleteToolCall":
      return relativeTo(String(args.path ?? args.file_path ?? args.target_file ?? ""), workspace);
    case "globToolCall":
      return String(args.globPattern ?? "");
    case "grepToolCall":
    case "semanticSearchToolCall":
      return String(args.pattern ?? args.query ?? "");
    case "shellToolCall":
      return String(args.command ?? "").replace(typeof workspace === "string" && workspace ? new RegExp(`${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`, "g") : /$^/, "");
    case "taskToolCall":
      return String(args.description ?? "");
    default:
      return "";
  }
}

/** One stream-json line from `cursor-agent -p --output-format stream-json` → a UI event (or null for noise). */
export function parseStreamLine(line: string, workspace?: string): ChatEvent | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = String(d.type ?? "");
  const subtype = String(d.subtype ?? "");
  if (type === "system" && subtype === "init") {
    return { kind: "init", sessionId: String(d.session_id ?? ""), model: String(d.model ?? "") };
  }
  if (type === "assistant") {
    const msg = d.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const text = (msg?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    return text ? { kind: "text", text } : null;
  }
  if (type === "thinking" && subtype === "delta") {
    return { kind: "thinking" };
  }
  if (type === "tool_call" && (subtype === "started" || subtype === "completed")) {
    const call = (d.tool_call ?? {}) as Record<string, unknown>;
    const tool = Object.keys(call).find((k) => k.endsWith("ToolCall")) ?? "tool";
    const body = (call[tool] ?? {}) as { args?: Record<string, unknown>; result?: Record<string, unknown> };
    const args = body.args ?? {};
    const id = String(d.call_id ?? call.toolCallId ?? "").split("\n")[0];
    const fallbackName = tool.replace(/ToolCall$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
    const label = `${TOOL_LABELS[tool] ?? fallbackName} ${describeArgs(tool, args, workspace)}`.trim();
    const rawPath = /^(read|edit|write|delete)ToolCall$/.test(tool) ? String(args.path ?? args.file_path ?? args.target_file ?? "") : "";
    const filePath = rawPath ? relativeTo(rawPath, workspace) : null;
    if (subtype === "started") {
      return { kind: "tool", id, tool, label, path: filePath, status: "started" };
    }
    const result = body.result ?? {};
    const ok = !("error" in result) && !("rejected" in result);
    const success = (result.success ?? {}) as Record<string, unknown>;
    const diff = tool === "editToolCall" || tool === "writeToolCall" ? (typeof success.diffString === "string" ? success.diffString : null) : null;
    let detail: string | null = null;
    if ("rejected" in result) {
      detail = "not run (needs approval; enable Run commands in Settings)";
    } else if ("error" in result) {
      detail = String((result.error as { error?: unknown })?.error ?? "error").slice(0, 200);
    } else if (tool === "shellToolCall") {
      const out = String(success.stdout ?? success.output ?? "");
      detail = out.trim().split("\n").slice(-6).join("\n").slice(0, 600) || null;
    }
    return { kind: "tool", id, tool, label, path: filePath, status: "completed", ok, diff, detail };
  }
  if (type === "result") {
    const u = d.usage as Partial<Record<keyof Usage, number>> | undefined;
    const usage: Usage | null = u
      ? { inputTokens: Number(u.inputTokens ?? 0), outputTokens: Number(u.outputTokens ?? 0), cacheReadTokens: Number(u.cacheReadTokens ?? 0), cacheWriteTokens: Number(u.cacheWriteTokens ?? 0) }
      : null;
    return { kind: "result", ok: !d.is_error, text: String(d.result ?? ""), usage, durationMs: Number(d.duration_ms ?? 0), sessionId: typeof d.session_id === "string" ? d.session_id : null };
  }
  return null;
}

/** Cost of a turn's usage at a price (USD). */
export function usageCostUsd(usage: Usage, price: { input: number | null; cacheWrite: number | null; cacheRead: number | null; output: number | null }): number | null {
  if (price.input === null || price.output === null) {
    return null;
  }
  const cacheRead = price.cacheRead ?? price.input;
  const cacheWrite = price.cacheWrite ?? price.input;
  return (usage.inputTokens * price.input + usage.cacheReadTokens * cacheRead + usage.cacheWriteTokens * cacheWrite + usage.outputTokens * price.output) / 1_000_000;
}

export interface TurnCost {
  usd: number | null;
  /** The same tokens at Auto's fixed billed rate: what this turn's tokens would have cost on Auto. */
  atAutoRateUsd: number;
  price: ResolvedPrice;
}

export function priceTurn(usage: Usage, model: string, pricing: PricingTable | null): TurnCost {
  const price = resolveModelPrice(model, pricing);
  return { usd: usageCostUsd(usage, price), atAutoRateUsd: usageCostUsd(usage, AUTO_RATE) ?? 0, price };
}

/**
 * With `--stream-partial-output` the CLI sends the reply as word deltas and then repeats the whole segment as
 * one message. `segment` is what has been appended since the last consolidation; an incoming text equal to it is
 * that repeat and adds nothing. Returns the text to append and the new segment.
 */
export function consolidateText(segment: string, incoming: string): { append: string; segment: string } {
  if (incoming === segment && segment.length > 0) {
    return { append: "", segment: "" };
  }
  // The repeat can differ from the deltas in whitespace: a long message whose tail equals the streamed tail is
  // the repeat, not new text (a fresh delta is never that long).
  if (segment.length > 40 && incoming.length > 40 && segment.trimEnd().slice(-40) === incoming.trimEnd().slice(-40)) {
    return { append: "", segment: "" };
  }
  if (segment.length > 0 && incoming.length > segment.length && incoming.startsWith(segment)) {
    // A repeat that carries more than what streamed (rare): append only the remainder.
    return { append: incoming.slice(segment.length), segment: "" };
  }
  return { append: incoming, segment: segment + incoming };
}

const TIER_ORDER: Tier[] = ["fast", "balanced", "deep"];

/**
 * A conversation keeps its model unless a later request needs a stronger tier: switching models mid-conversation
 * costs a fresh cache write on the new model (measured: 19.8k uncached tokens against 98 on the same model) and
 * confuses the reader. Only an escalation moves it up.
 */
export function stickyRoute(previous: { tier: Tier; model: string } | null, routed: Route): Route & { kept: boolean } {
  if (!previous || previous.model === routed.model) {
    return { ...routed, kept: false };
  }
  if (TIER_ORDER.indexOf(routed.tier) > TIER_ORDER.indexOf(previous.tier)) {
    return { ...routed, kept: false };
  }
  return { ...routed, tier: previous.tier, model: previous.model, kept: true };
}

/** After a streamed segment is complete (its repeat arrived, or a tool call started), the reply continues as a new paragraph. */
export function endParagraph(text: string): string {
  if (!text || text.endsWith("\n\n")) {
    return text;
  }
  return text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
}

/** A non-JSON line the CLI prints when it cannot run the model (usage limit, unknown model, not logged in). */
export function parseCliErrorLine(line: string): { kind: "usage_limit" | "not_logged_in" | "unknown_model" | "error"; message: string } | null {
  const text = line.trim();
  if (!text || text.startsWith("{")) {
    return null;
  }
  if (/usage limit|ActionRequiredError|spend limit/i.test(text)) {
    // "You've hit your usage limit for Opus You've saved $104 on API model usage… Switch to…": keep the first clause.
    const message = text.replace(/^ActionRequiredError:\s*/, "").split(/\s+You've saved|\s+Switch to|\s{2,}|\. /)[0].trim();
    return { kind: "usage_limit", message };
  }
  if (/not logged in|login|unauthorized|401/i.test(text)) {
    return { kind: "not_logged_in", message: text };
  }
  if (/unknown model|model .* not (found|available)|invalid model/i.test(text)) {
    return { kind: "unknown_model", message: text };
  }
  if (/error/i.test(text)) {
    return { kind: "error", message: text };
  }
  return null;
}

/** `cursor-agent status` prints "✓ Logged in as <email>" or "Not logged in". */
export function parseCliStatus(output: string): { loggedIn: boolean; account: string | null } {
  const m = output.match(/Logged in as\s+(\S+)/i);
  if (m) {
    return { loggedIn: true, account: m[1] };
  }
  return { loggedIn: false, account: null };
}
