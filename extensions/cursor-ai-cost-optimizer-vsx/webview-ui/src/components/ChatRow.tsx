/**
 * One turn: the user's request, then a header row naming the model that answered (the counterpart of Cline's
 * "api request" row, with the cost on it), the tool calls as Cline's CodeAccordian (edits with Roo Code's diff
 * view, commands with their output), and the reply as Markdown.
 */
import { useState } from "react";
import CodeAccordian from "@/components/common/CodeAccordian";
import { formatTokens, formatUsd, vscode, type ToolRowState, type TurnState } from "../types";
import MarkdownBlock from "./MarkdownBlock";

const TIER_NAME: Record<string, string> = { fast: "Fast", balanced: "Balanced", deep: "Deep" };

function ToolRow({ tool, turnId, expanded, onToggle, canDecide }: { tool: ToolRowState; turnId: number; expanded: Record<string, boolean>; onToggle: (key: string) => void; canDecide: boolean }) {
  const key = `${turnId}:${tool.id}`;
  const isEdit = Boolean(tool.diff && tool.path);
  const mark = tool.status === "started" ? <span className="spinner" aria-label="running" /> : tool.ok === false ? <span className="mark-fail">✗</span> : tool.ok === null ? <span className="muted" title="interrupted">–</span> : <span className="mark-ok">✓</span>;
  const hasBody = Boolean(tool.diff || tool.detail);
  return (
    <div className={`tool-row${tool.ok === false ? " failed" : ""}`}>
      <div className="tool-line">
        {mark}
        <span className="tool-label" title={tool.label}>
          {tool.label}
        </span>
        {tool.path ? (
          <a
            href="#"
            className="open-file"
            title="Open file"
            onClick={(e) => {
              e.preventDefault();
              vscode.postMessage({ type: "open", path: tool.path as string });
            }}
          >
            open
          </a>
        ) : null}
        {isEdit && canDecide ? (
          tool.decision === "undone" ? (
            <span className="muted decision">undone</span>
          ) : tool.decision === "kept" ? (
            <span className="muted decision">kept</span>
          ) : (
            <span className="decision-buttons">
              <button className="button small" title="Keep this file's changes" onClick={() => vscode.postMessage({ type: "keepFile", turnId, path: tool.path as string })}>
                Keep
              </button>
              <button className="button secondary small" title="Put this file back as it was before this turn" onClick={() => vscode.postMessage({ type: "undoFile", turnId, path: tool.path as string })}>
                Undo
              </button>
            </span>
          )
        ) : null}
      </div>
      {hasBody ? (
        <div className="accordian-wrap">
          <CodeAccordian
            diff={tool.diff ?? undefined}
            code={tool.diff ? undefined : (tool.detail ?? "")}
            path={tool.diff ? (tool.path ?? undefined) : undefined}
            isConsoleLogs={!tool.diff}
            isExpanded={Boolean(expanded[key])}
            onToggleExpand={() => onToggle(key)}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function ChatRow({ turn, expanded, onToggle, checkpointsAvailable }: { turn: TurnState; expanded: Record<string, boolean>; onToggle: (key: string) => void; checkpointsAvailable: boolean }) {
  const running = turn.status === "running";
  const u = turn.usage;
  const edited = turn.tools.some((t) => t.diff);
  const editedFiles = new Set(turn.tools.filter((t) => t.diff && t.path).map((t) => t.path)).size;
  const [confirmRestore, setConfirmRestore] = useState(false);
  return (
    <div className="turn">
      <div className="user-message">
        {turn.prompt}
        {turn.contextNote ? <div className="context-note">{turn.contextNote}</div> : null}
      </div>
      <div className="model-row">
        {running ? <span className="spinner" aria-label="running" /> : null}
        <span className="model-name">{turn.modelLabel}</span>
        <span className="tier-badge">{TIER_NAME[turn.tier] ?? turn.tier}</span>
        {turn.usd !== null ? (
          <span className="turn-cost" title={u ? `↑ ${formatTokens(u.inputTokens)} ↓ ${formatTokens(u.outputTokens)} cache → ${formatTokens(u.cacheReadTokens)}` : undefined}>
            {formatUsd(turn.usd)}
            {turn.atAutoRateUsd !== null ? <span className="muted"> · at Auto's rate {formatUsd(turn.atAutoRateUsd)}</span> : null}
            {turn.seconds ? <span className="muted"> · {turn.seconds}s</span> : null}
          </span>
        ) : null}
        {turn.status === "stopped" ? <span className="muted">stopped</span> : null}
        {running && turn.thinking && !turn.tools.some((t) => t.status === "started") ? <span className="muted">thinking…</span> : null}
      </div>
      {turn.notes.map((n, i) => (
        <div key={i} className="note">
          {n}
        </div>
      ))}
      {turn.tools.length ? (
        <div className="tools">
          {turn.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} turnId={turn.id} expanded={expanded} onToggle={onToggle} canDecide={!running && Boolean(turn.checkpoint) && checkpointsAvailable && !turn.restored} />
          ))}
        </div>
      ) : null}
      {turn.text ? (
        <div className="reply">
          <MarkdownBlock markdown={turn.text} />
        </div>
      ) : null}
      {turn.error ? <div className="error">{turn.error}</div> : null}
      {!running && edited && turn.checkpoint && checkpointsAvailable ? (
        <div className="turn-actions">
          {turn.restored ? (
            <span className="muted">Files restored to how they were before this turn.</span>
          ) : confirmRestore ? (
            <span className="confirm-row">
              <span>Put {editedFiles} {editedFiles === 1 ? "file" : "files"} back as before this turn? Everything changed in the workspace since then is undone, your own edits included.</span>
              <button className="button small" onClick={() => { setConfirmRestore(false); vscode.postMessage({ type: "restore", turnId: turn.id }); }}>
                Restore
              </button>
              <button className="button secondary small" onClick={() => setConfirmRestore(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <span className="decision-buttons">
              <button className="button secondary small" onClick={() => setConfirmRestore(true)} title="Put every file back as it was before this turn ran (a checkpoint of the workspace)">
                Undo all
              </button>
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
