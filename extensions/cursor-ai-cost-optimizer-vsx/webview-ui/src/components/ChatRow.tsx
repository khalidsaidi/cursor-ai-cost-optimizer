/**
 * One turn: the user's request, then a header row naming the model that answered (the counterpart of Cline's
 * "api request" row, with the cost on it), the tool calls as accordions (edits with their diff, commands with
 * their output), and the reply as Markdown.
 */
import { formatTokens, formatUsd, type ToolRowState, type TurnState } from "../types";
import CodeAccordian from "./CodeAccordian";
import MarkdownBlock from "./MarkdownBlock";

const TIER_NAME: Record<string, string> = { fast: "Fast", balanced: "Balanced", deep: "Deep" };

function ToolRow({ tool, turnId, expanded, onToggle }: { tool: ToolRowState; turnId: number; expanded: Record<string, boolean>; onToggle: (key: string) => void }) {
  const key = `${turnId}:${tool.id}`;
  const mark = tool.status === "started" ? <span className="spinner" aria-label="running" /> : tool.ok === false ? <span className="codicon-x">✗</span> : <span className="codicon-check">✓</span>;
  const hasBody = Boolean(tool.diff || tool.detail);
  return (
    <div className={`tool-row${tool.ok === false ? " failed" : ""}`}>
      <div className="tool-line">
        {mark}
        <span className="tool-label">{tool.label}</span>
      </div>
      {hasBody ? (
        <CodeAccordian
          path={tool.path}
          diff={tool.diff}
          output={tool.detail}
          isExpanded={Boolean(expanded[key])}
          onToggleExpand={() => onToggle(key)}
        />
      ) : null}
    </div>
  );
}

export default function ChatRow({ turn, expanded, onToggle }: { turn: TurnState; expanded: Record<string, boolean>; onToggle: (key: string) => void }) {
  const running = turn.status === "running";
  const u = turn.usage;
  return (
    <div className="turn">
      <div className="user-message">{turn.prompt}</div>
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
      </div>
      {turn.fallbackFrom ? <div className="note">No model is set for the {TIER_NAME[turn.fallbackFrom]} tier, so this ran on the {TIER_NAME[turn.tier]} tier's model.</div> : null}
      {turn.guardrail && /risk/.test(turn.guardrail) ? <div className="note">Risky work: sent to a stronger tier.</div> : null}
      {turn.tools.length ? (
        <div className="tools">
          {turn.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} turnId={turn.id} expanded={expanded} onToggle={onToggle} />
          ))}
        </div>
      ) : null}
      {turn.text ? (
        <div className="reply">
          <MarkdownBlock markdown={turn.text} />
        </div>
      ) : null}
      {turn.error ? <div className="error">{turn.error}</div> : null}
    </div>
  );
}
