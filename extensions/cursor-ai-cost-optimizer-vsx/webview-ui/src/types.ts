/** State the extension pushes to the webview (one message, whole conversation), and what the webview sends back. */

export type Tier = "fast" | "balanced" | "deep";

export interface ToolRowState {
  id: string;
  tool: string;
  label: string;
  /** For file tools: the workspace-relative path shown in the accordion header. */
  path: string | null;
  status: "started" | "completed";
  ok: boolean | null;
  /** Unified diff text for edits (rendered with Roo Code's DiffView). */
  diff: string | null;
  /** Command output or an error, shown in the accordion body. */
  detail: string | null;
}

export interface TurnState {
  id: number;
  prompt: string;
  /** "with src/app.ts lines 10-20": the active file and selection sent along with the request. */
  contextNote: string | null;
  tier: Tier;
  model: string;
  modelLabel: string;
  /** One-line explanations: fallback, escalation, kept model, usage limit, stop. */
  notes: string[];
  status: "running" | "done" | "error" | "stopped";
  thinking: boolean;
  error: string | null;
  /** The reply as Markdown (rendered here). */
  text: string;
  tools: ToolRowState[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
  usd: number | null;
  atAutoRateUsd: number | null;
  seconds: number | null;
  /** A checkpoint of the workspace taken before this turn ran; restoring puts the files back as they were. */
  checkpoint: string | null;
  restored: boolean;
}

export interface HistoryEntry {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
  usd: number;
}

export interface ChatState {
  type: "state";
  running: boolean;
  workspace: string;
  conversationId: string | null;
  context: { include: boolean; file: string | null; selection: string | null };
  history: HistoryEntry[];
  checkpointsAvailable: boolean;
  turns: TurnState[];
  totals: { usd: number; atAutoRateUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; turns: number } | null;
}

export interface NoticeMessage {
  type: "notice";
  text: string;
}

export interface FocusMessage {
  type: "focus";
}

export type ExtensionMessage = ChatState | NoticeMessage | FocusMessage;

export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; forced: Tier | "auto" }
  | { type: "stop" }
  | { type: "new" }
  | { type: "context"; include: boolean }
  | { type: "restore"; turnId: number }
  | { type: "history"; id: string }
  | { type: "historyDelete"; id: string }
  | { type: "settings" }
  | { type: "models" }
  | { type: "open"; path: string };

declare global {
  interface Window {
    acquireVsCodeApi: () => { postMessage: (m: WebviewMessage) => void; getState: () => unknown; setState: (s: unknown) => void };
  }
}

export const vscode = window.acquireVsCodeApi();

export function formatUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) {
    return "";
  }
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}m`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  }
  return String(n);
}
