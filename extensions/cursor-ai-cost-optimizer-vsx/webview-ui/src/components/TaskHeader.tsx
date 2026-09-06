/**
 * Conversation totals, the way Cline's TaskHeader shows them: tokens in/out, cache reads/writes, cost. Ours adds
 * what the same tokens would have cost at Auto's billed rate, which is the number this extension exists for.
 */
import { formatTokens, formatUsd, type ChatState } from "../types";

export default function TaskHeader({ state }: { state: ChatState }) {
  const t = state.totals;
  if (!t || !t.turns) {
    return null;
  }
  const saved = t.atAutoRateUsd - t.usd;
  return (
    <div className="task-header" title="Totals for this conversation, from the token usage the Cursor CLI reports for each turn">
      <span className="metric">
        <span className="metric-label">Tokens</span>
        <span>↑ {formatTokens(t.inputTokens)}</span>
        <span>↓ {formatTokens(t.outputTokens)}</span>
      </span>
      {t.cacheReadTokens || t.cacheWriteTokens ? (
        <span className="metric">
          <span className="metric-label">Cache</span>
          {t.cacheWriteTokens ? <span>+{formatTokens(t.cacheWriteTokens)}</span> : null}
          {t.cacheReadTokens ? <span>→ {formatTokens(t.cacheReadTokens)}</span> : null}
        </span>
      ) : null}
      <span className="metric" title={`This conversation cost ${formatUsd(t.usd)}. Auto would have billed ${formatUsd(t.atAutoRateUsd)} for the same work.`}>
        <span className="metric-label">Cost</span>
        <span className="cost">{formatUsd(t.usd)}</span>
        {saved > 0.0005 ? <span className="saved">saved {formatUsd(saved)} vs Auto</span> : <span className="muted">Auto: {formatUsd(t.atAutoRateUsd)}</span>}
      </span>
    </div>
  );
}
