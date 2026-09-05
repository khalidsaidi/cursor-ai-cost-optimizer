import { clamp, asNumber, TIERS } from "./common.mjs";

export const DEFAULT_OVERRIDE_TOKENS = {
  fast: "[cco:fast]",
  balanced: "[cco:balanced]",
  deep: "[cco:deep]",
  auto: "[cco:auto]"
};

const SIGNALS = ["complexity", "risk", "breadth", "uncertainty", "latency"];

export function normalizeScores(raw) {
  const scores = raw || {};
  const out = {};
  for (const key of SIGNALS) {
    out[key] = clamp(asNumber(scores[key], 0), 0, 10);
  }
  return out;
}

/** Detect a manual override token anywhere in the text. Last token wins. */
/** Plain-language steering, so nobody has to remember a token. Explicit tokens still win. */
const PHRASES = [
  ["deep", /\b(use|with|on|pick|prefer)\s+(the\s+)?(best|strongest|smartest|most capable|top|strong|big|frontier)\s+model\b|\bbest model\b|\bthink hard(er)?\b/],
  ["fast", /\b(use|with|on|pick|prefer)\s+(the\s+)?(cheapest|fastest|cheap|fast|small|quick)\s+model\b|\bquick and cheap\b|\bcheaply\b/],
  ["off", /\b(don'?t|do not|no)\s+(route|delegate|routing|delegation)\b|\bwithout (routing|delegating|subagents?)\b|\bdo it (yourself|here|in this chat)\b/],
  ["auto", /\b(back to|resume|restore)\s+(auto(matic)?\s+)?routing\b/]
];

export function parseOverride(text, tokens = DEFAULT_OVERRIDE_TOKENS) {
  const lower = String(text ?? "").toLowerCase();
  let best = null;
  let bestIndex = -1;
  for (const [tier, token] of Object.entries({ ...DEFAULT_OVERRIDE_TOKENS, ...(tokens || {}) })) {
    if (!token) {
      continue;
    }
    const index = lower.lastIndexOf(String(token).toLowerCase());
    if (index > bestIndex) {
      bestIndex = index;
      best = tier;
    }
  }
  if (best) {
    return best;
  }
  for (const [tier, re] of PHRASES) {
    if (re.test(lower)) {
      return tier;
    }
  }
  return null;
}

/**
 * Parse an explicit scores line emitted by the routing rule, e.g.
 * `CCO-SCORES: complexity=4 risk=2 breadth=1 uncertainty=1 latency=6`
 */
export function parseScoresLine(text) {
  const match = String(text ?? "").match(/CCO-SCORES:\s*([^\n]+)/i);
  if (!match) {
    return null;
  }
  const out = {};
  let found = 0;
  for (const key of SIGNALS) {
    const m = match[1].match(new RegExp(`${key}\\s*[=:]\\s*([0-9]+(?:\\.[0-9]+)?)`, "i"));
    if (m) {
      out[key] = clamp(Number(m[1]), 0, 10);
      found += 1;
    }
  }
  return found >= 3 ? normalizeScores(out) : null;
}

const RULES = {
  risk: [
    [/\b(prod|production|live|customer[- ]facing)\b/, 3],
    [/\b(auth|oauth|sso|jwt|sessions?|passwords?|secrets?|tokens?|credentials?|permissions?|rbac|acl|signing keys?|api keys?|private keys?)\b/, 3],
    [/\b(payments?|billing|invoices?|stripe|checkout|refunds?|ledger|money)\b/, 3],
    [/\b(security|vuln|cve|xss|csrf|injection|encrypt|privacy|pii|gdpr|hipaa|compliance)\b/, 3],
    [/\b(migrations?|migrate|drop|truncate|delete|destroy|wipe|purge|rm -rf|force[- ]push|rollback)\b/, 3],
    [/\b(deploy|deployment|release|infra|terraform|kubernetes|k8s|helm|dns|firewall|iam)\b/, 2],
    [/\b(data loss|irreversible|backup|restore)\b/, 2],
    [/\b(best practice|compliance|audit|regulat)/, 1]
  ],
  complexity: [
    [/\b(architect|architecture|redesign|rewrite|refactor|restructure|re-architect)\b/, 3],
    [/\b(debug|root cause|flaky|intermittent|race|deadlock|memory leak|regression)\b/, 3],
    [/\b(perf|performance|latency|throughput|optimi[sz]e|scal(e|ing))\b/, 2],
    [/\b(implement|build|create|design|add feature|integrate|integration)\b/, 2],
    [/\b(plan|then|after that|step \d|multi[- ]step|end[- ]to[- ]end|e2e)\b/, 1],
    [/\b(spec|protocol|rfc|api docs|unknown api|new library)\b/, 1],
    [/\b(concurren|distributed|async|stream|websocket|realtime)\b/, 1]
  ],
  breadth: [
    [/\b(monorepo|across (the )?(repo|codebase|project|services)|repo[- ]wide|codebase[- ]wide|every (file|module|service))\b/, 4],
    [/\b(multiple|several|many|all) (files|modules|packages|services|components)\b/, 3],
    [/\b(cross[- ]service|microservice|frontend and backend|full[- ]stack)\b/, 3],
    [/\b(module|package|service|component)s\b/, 1]
  ],
  uncertainty: [
    [/\b(not sure|unsure|no idea|unclear|ambiguous|i think|maybe|somehow|something like)\b/, 3],
    [/\b(investigate|research|explore|figure out|find out|look into|why (does|is|do)|options|trade-?offs?)\b/, 2],
    [/\?\s*$/, 1]
  ],
  latency: [
    [/\b(asap|urgent|hurry|right now|immediately|quick(ly)?|fast|in a rush)\b/, 4],
    [/\b(one[- ]liner|just (tell|give|show) me|just the (command|answer|code)|tl;?dr|short answer|briefly)\b/, 3],
    [/\b(what is|what's|how do i|which command|remind me)\b/, 1]
  ]
};

/**
 * Keyword + shape heuristics that estimate the five routing signals (0-10) from prompt text.
 * Deterministic and cheap: used by hooks where no model-produced scores are available.
 */
/** Drop fenced code blocks and very long lines (pasted logs) so their words do not drive the routing. */
export function proseOnly(text) {
  // Drop fenced code and pasted machine output (stack traces, JSON, logs) so they do not skew the
  // keyword heuristics, but keep long sentences: a line stays if it is short or reads like prose.
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((line) => {
      if (line.length <= 200) return true;
      const letters = (line.match(/[A-Za-z\u00C0-\u024F ]/g) || []).length;
      return letters / line.length >= 0.8;
    })
    .join("\n");
}

export function heuristicScores(text) {
  const raw = proseOnly(text);
  const lower = raw.toLowerCase();
  const scores = { complexity: 1, risk: 0, breadth: 0, uncertainty: 0, latency: 0 };

  for (const [signal, rules] of Object.entries(RULES)) {
    for (const [re, weight] of rules) {
      const hits = new Set((lower.match(new RegExp(re.source, "g")) || []).map((h) => h.trim()));
      if (hits.size) {
        // first distinct keyword carries the rule's weight; extra distinct keywords add +1 each (max +2)
        scores[signal] += weight + Math.min(hits.size - 1, 2);
      }
    }
  }

  const words = lower.split(/\s+/).filter(Boolean).length;
  if (words > 120) {
    scores.complexity += 1;
  }
  if (words > 300) {
    scores.complexity += 1;
    scores.breadth += 1;
  }
  if (words <= 12) {
    scores.latency += 2;
  }
  const filesMentioned = (raw.match(/[\w./-]+\.(ts|tsx|js|mjs|cjs|py|go|rs|java|kt|rb|php|cs|sql|yml|yaml|json|md)\b/g) || []).length;
  if (filesMentioned >= 3) {
    scores.breadth += 2;
  } else if (filesMentioned >= 1) {
    scores.breadth += 1;
  }
  if (/```/.test(String(text ?? ""))) {
    scores.complexity += 1;
  }
  if (/\b(test|tests|verify|verification|thorough|carefully|deep dive|double[- ]check)\b/.test(lower)) {
    scores.complexity += 1;
  }

  return normalizeScores(scores);
}

export function effortScore(scores, weights = {}) {
  const s = normalizeScores(scores);
  return clamp(
    asNumber(weights.complexity, 0.45) * s.complexity +
      asNumber(weights.risk, 0.35) * s.risk +
      asNumber(weights.breadth, 0.15) * s.breadth +
      asNumber(weights.uncertainty, 0.1) * s.uncertainty +
      asNumber(weights.latency, -0.2) * s.latency,
    0,
    10
  );
}

export function tierIndex(tier) {
  return Math.max(0, TIERS.indexOf(String(tier || "").toLowerCase()));
}

export function escalateTier(tier, steps = 1) {
  return TIERS[clamp(tierIndex(tier) + steps, 0, TIERS.length - 1)];
}

/**
 * Deterministic tier decision from scores and config.
 * Returns { tier, effort, guardrail, override, minTier }.
 */
export function decideTier({ scores, override = null, config = {} }) {
  const s = normalizeScores(scores);
  const weights = config.weights || {};
  const thresholds = config.thresholds || {};
  const guards = config.guardrails || {};
  const fastMax = asNumber(thresholds.fastMax, 3.4);
  const balancedMax = asNumber(thresholds.balancedMax, 6.4);
  const riskForceDeep = asNumber(guards.riskForceDeep, 9);
  const riskNoFast = asNumber(guards.riskNoFast, 7);
  const effort = effortScore(s, weights);

  let tier = "balanced";
  let guardrail = null;
  if (effort <= fastMax) {
    tier = "fast";
  } else if (effort > balancedMax) {
    tier = "deep";
  }
  if (s.latency >= 7 && s.risk <= 3 && s.complexity <= 3) {
    tier = "fast";
    guardrail = "latency_fast_path";
  }

  let minTier = "fast";
  if (s.risk >= riskNoFast) {
    minTier = "balanced";
  }
  if (s.risk >= riskForceDeep) {
    minTier = "deep";
  }
  if (tierIndex(tier) < tierIndex(minTier)) {
    tier = minTier;
    guardrail = s.risk >= riskForceDeep ? "risk_force_deep" : "risk_no_fast";
  }

  if (override && override !== "auto") {
    if (override !== tier) {
      guardrail = guardrail ? `${guardrail};override_${override}` : `override_${override}`;
    }
    tier = override;
  }

  return { tier, effort: Number(effort.toFixed(2)), guardrail, override, minTier, scores: s };
}

/**
 * Field-learning escalation: if a tier's observed error/rework EMA is above the configured
 * threshold, bump one tier (never past deep, never below a user override).
 */
export function applyStateEscalation({ tier, state, config = {}, override = null }) {
  if (override && override !== "auto") {
    return { tier, escalated: false, reason: null };
  }
  const threshold = asNumber(config.learning?.escalateWhenErrorEmaAbove, 0.45);
  const minCount = asNumber(config.learning?.minObservations, 3);
  const obs = state?.tiers?.[tier];
  if (!obs || asNumber(obs.count, 0) < minCount) {
    return { tier, escalated: false, reason: null };
  }
  const failureEma = clamp(asNumber(obs.emaError, 0) + asNumber(obs.emaRework, 0), 0, 1);
  if (failureEma > threshold && tier !== "deep") {
    return {
      tier: escalateTier(tier),
      escalated: true,
      reason: `tier ${tier} failure EMA ${failureEma.toFixed(2)} > ${threshold}`
    };
  }
  return { tier, escalated: false, reason: null };
}

export function formatScoresLine(scores) {
  const s = normalizeScores(scores);
  return `CCO-SCORES: complexity=${s.complexity} risk=${s.risk} breadth=${s.breadth} uncertainty=${s.uncertainty} latency=${s.latency}`;
}

/** Question-shaped requests (explain/what/why/how…, or ending in ?) are answered, not built. */
export function isQuestionLike(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) {
    return false;
  }
  if (/\b(create|add|implement|write|fix|refactor|change|update|rename|delete|remove|run|install|build|migrate|deploy|generate|convert|move)\b/.test(t) && !/\?\s*$/.test(t)) {
    return false;
  }
  return /^(what|why|how|explain|describe|summari[sz]e|is |are |does |do |can |could |should |which |where |when |tell me|show me|list )/.test(t) || /\?\s*$/.test(t);
}

/** A tiny, one-file edit (typo, rename, comment, one-liner) is not worth a subagent round trip. */
export function isTinyTask(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) {
    return false;
  }
  const words = t.split(/\s+/).length;
  const files = (t.match(/[\w./-]+\.(ts|tsx|js|mjs|cjs|py|go|rs|java|kt|rb|php|cs|sql|yml|yaml|json|md|txt)\b/g) || []).length;
  const tinyVerb = /\b(typo|rename|comment|one[- ]liner|one line|bump|indent|whitespace|reorder|capitali[sz]e|spelling|wording|tweak)\b/.test(t);
  const bigSignal = /\b(tests?|refactor|implement|feature|migrate|across|all files|every|debug|investigate|architecture|security|production)\b/.test(t);
  return words <= 25 && files <= 1 && tinyVerb && !bigSignal;
}
