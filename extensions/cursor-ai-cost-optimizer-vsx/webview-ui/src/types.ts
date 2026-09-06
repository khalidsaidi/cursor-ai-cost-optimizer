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
  /** Unified diff text for edits (rendered like VS Code's diff editor). */
  diff: string | null;
  /** Command output or an error, shown in the accordion body. */
  detail: string | null;
}

export interface TurnState {
  id: number;
  prompt: string;
  tier: Tier;
  model: string;
  modelLabel: string;
  guardrail: string | null;
  fallbackFrom: Tier | null;
  status: "running" | "done" | "error" | "stopped";
  error: string | null;
  /** The reply as Markdown (rendered here). */
  text: string;
  tools: ToolRowState[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
  usd: number | null;
  atAutoRateUsd: number | null;
  seconds: number | null;
}

export interface ChatState {
  type: "state";
  running: boolean;
  workspace: string;
  turns: TurnState[];
  totals: { usd: number; atAutoRateUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; turns: number } | null;
}

export interface NoticeMessage {
  type: "notice";
  text: string;
}

export type ExtensionMessage = ChatState | NoticeMessage;

export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; forced: Tier | "auto" }
  | { type: "stop" }
  | { type: "new" }
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
