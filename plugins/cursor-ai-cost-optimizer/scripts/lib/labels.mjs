// Human wording for everything a user reads in Cursor (tool cards, footers, notifications).
// Internal names (cco-fast, FAST, claude-sonnet-5-thinking-high, reason codes) never reach the user.
import { resolveModelPrice } from "./pricing.mjs";

const TIER_LABELS = { fast: "Fast", balanced: "Balanced", deep: "Deep" };

export function tierLabel(tier) {
  return TIER_LABELS[String(tier || "").toLowerCase()] || String(tier || "");
}

function prettify(id) {
  return String(id)
    .replace(/^cursor-/, "")
    .split("-")
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\bGpt\b/g, "GPT");
}

/** "Claude Sonnet 5", "Composer 2.5", "Grok 4.6", "Auto"; falls back to a tidied id when the price table has no row. */
export function modelLabel(id, pricing = null) {
  if (!id || id === "inherit") {
    return "the chat model";
  }
  if (/^auto$/i.test(id)) {
    return "Auto";
  }
  try {
    const price = pricing ? resolveModelPrice(id, pricing) : null;
    if (price?.matchedRow) {
      return String(price.matchedRow).replace(/\s*\(Fast\)\s*$/i, " Fast");
    }
  } catch {}
  return prettify(id);
}

/** Why a delegation was moved, in words. */
export function reasonLabel(reason) {
  const r = String(reason || "");
  if (r.startsWith("override_")) return "as requested";
  if (r.startsWith("quality_") || r === "risk_guardrail") return "risky or complex change";
  if (r.startsWith("learning:")) return "recent failures at the lower tier";
  if (r === "budget_exceeded_force_fast") return "over the chat budget";
  if (r.startsWith("model_limited")) return "usage limit";
  return r.replace(/_/g, " ");
}

/** The one line the user reads at the end of a routed task. */
export function footerLine(parts) {
  return `Cost Optimizer · ${parts.filter(Boolean).join(" · ")}`;
}
