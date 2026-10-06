/**
 * TypeScript port of plugins/cursor-ai-cost-optimizer/scripts/lib/scorer.mjs
 * (heuristicScores + decideTier). Keep the regexes, weights, thresholds and
 * guardrails identical to the plugin so the extension's "Recommend Tier"
 * matches what the installed hooks would decide.
 */

export type Tier = "fast" | "balanced" | "deep";
export type Signal = "complexity" | "risk" | "breadth" | "uncertainty" | "latency";
export type Scores = Record<Signal, number>;

export const TIERS: Tier[] = ["fast", "balanced", "deep"];
const SIGNALS: Signal[] = ["complexity", "risk", "breadth", "uncertainty", "latency"];

export const DEFAULT_OVERRIDE_TOKENS: Record<Tier | "auto", string> = {
  fast: "[cco:fast]",
  balanced: "[cco:balanced]",
  deep: "[cco:deep]",
  auto: "[cco:auto]",
};

export interface ScorerConfig {
  weights?: Partial<Record<Signal, number>>;
  thresholds?: { fastMax?: number; balancedMax?: number };
  guardrails?: { riskNoFast?: number; riskForceDeep?: number };
}

export const DEFAULT_CONFIG: Required<ScorerConfig> = {
  weights: { complexity: 0.45, risk: 0.35, breadth: 0.15, uncertainty: 0.1, latency: -0.2 },
  thresholds: { fastMax: 3.4, balancedMax: 6.4 },
  guardrails: { riskNoFast: 7, riskForceDeep: 9 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeScores(raw?: Partial<Record<Signal, unknown>> | null): Scores {
  const scores = raw || {};
  const out = {} as Scores;
  for (const key of SIGNALS) {
    out[key] = clamp(asNumber(scores[key], 0), 0, 10);
  }
  return out;
}

/** Detect a manual override token anywhere in the text. Last token wins. */
export function parseOverride(text: string, tokens: Partial<Record<Tier | "auto", string>> = DEFAULT_OVERRIDE_TOKENS): Tier | "auto" | null {
  const lower = String(text ?? "").toLowerCase();
  let best: Tier | "auto" | null = null;
  let bestIndex = -1;
  const merged = { ...DEFAULT_OVERRIDE_TOKENS, ...(tokens || {}) };
  for (const [tier, token] of Object.entries(merged) as Array<[Tier | "auto", string]>) {
    if (!token) {
      continue;
    }
    const index = lower.lastIndexOf(String(token).toLowerCase());
    if (index > bestIndex) {
      bestIndex = index;
      best = tier;
    }
  }
  return best;
}

const RULES: Record<Signal, Array<[RegExp, number]>> = {
  risk: [
    [/\b(prod|production|live|customer[- ]facing)\b/, 3],
    [/\b(auth|oauth|sso|jwt|sessions?|passwords?|secrets?|tokens?|credentials?|permissions?|rbac|acl|signing keys?|api keys?|private keys?)\b/, 3],
    [/\b(payments?|billing|invoices?|stripe|checkout|refunds?|ledger|money)\b/, 3],
    [/\b(security|vuln|cve|xss|csrf|injection|encrypt|privacy|pii|gdpr|hipaa|compliance)\b/, 3],
    [/\b(migrations?|migrate|drop|truncate|delete|destroy|wipe|purge|rm -rf|force[- ]push|rollback)\b/, 3],
    [/\b(deploy|deployment|release|infra|terraform|kubernetes|k8s|helm|dns|firewall|iam)\b/, 2],
    [/\b(data loss|irreversible|backup|restore)\b/, 2],
    [/\b(best practice|compliance|audit|regulat)/, 1],
  ],
  complexity: [
    [/\b(architect|architecture|redesign|rewrite|refactor|restructure|re-architect)\b/, 3],
    [/\b(debug|root cause|flaky|intermittent|race|deadlock|memory leak|regression)\b/, 3],
    [/\b(perf|performance|latency|throughput|optimi[sz]e|scal(e|ing))\b/, 2],
    [/\b(implement|build|create|design|add feature|integrate|integration)\b/, 2],
    [/\b(plan|then|after that|step \d|multi[- ]step|end[- ]to[- ]end|e2e)\b/, 1],
    [/\b(spec|protocol|rfc|api docs|unknown api|new library)\b/, 1],
    [/\b(concurren|distributed|async|stream|websocket|realtime)\b/, 1],
  ],
  breadth: [
    [/\b(monorepo|across (the )?(repo|codebase|project|services)|repo[- ]wide|codebase[- ]wide|every (file|module|service))\b/, 4],
    [/\b(multiple|several|many|all) (files|modules|packages|services|components)\b/, 3],
    [/\b(cross[- ]service|microservice|frontend and backend|full[- ]stack)\b/, 3],
    [/\b(module|package|service|component)s\b/, 1],
  ],
  uncertainty: [
    [/\b(not sure|unsure|no idea|unclear|ambiguous|i think|maybe|somehow|something like)\b/, 3],
    [/\b(investigate|research|explore|figure out|find out|look into|why (does|is|do)|options|trade-?offs?)\b/, 2],
    [/\?\s*$/, 1],
  ],
  latency: [
    [/\b(asap|urgent|hurry|right now|immediately|quick(ly)?|fast|in a rush)\b/, 4],
    [/\b(one[- ]liner|just (tell|give|show) me|just the (command|answer|code)|tl;?dr|short answer|briefly)\b/, 3],
    [/\b(what is|what's|how do i|which command|remind me)\b/, 1],
  ],
};

/**
 * Keyword + shape heuristics that estimate the five routing signals (0-10) from prompt text.
 * Deterministic and cheap: mirrors the plugin's hook-side scorer.
 */
export function heuristicScores(text: string): Scores {
  const raw = String(text ?? "");
  const lower = raw.toLowerCase();
  const scores: Scores = { complexity: 1, risk: 0, breadth: 0, uncertainty: 0, latency: 0 };

  for (const [signal, rules] of Object.entries(RULES) as Array<[Signal, Array<[RegExp, number]>]>) {
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
  if (/```/.test(raw)) {
    scores.complexity += 1;
  }
  if (/\b(test|tests|verify|verification|thorough|carefully|deep dive|double[- ]check)\b/.test(lower)) {
    scores.complexity += 1;
  }

  return normalizeScores(scores);
}

export function effortScore(scores: Partial<Scores>, weights: Partial<Record<Signal, number>> = {}): number {
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

export function tierIndex(tier: string | null | undefined): number {
  return Math.max(0, TIERS.indexOf(String(tier || "").toLowerCase() as Tier));
}

export interface TierDecision {
  tier: Tier;
  effort: number;
  guardrail: string | null;
  override: Tier | "auto" | null;
  minTier: Tier;
  scores: Scores;
}

/**
 * Deterministic tier decision from scores and config (same as the plugin's decideTier).
 */
export function decideTier(input: { scores: Partial<Scores>; override?: Tier | "auto" | null; config?: ScorerConfig }): TierDecision {
  const { scores, override = null, config = {} } = input;
  const s = normalizeScores(scores);
  const weights = config.weights || {};
  const thresholds = config.thresholds || {};
  const guards = config.guardrails || {};
  const fastMax = asNumber(thresholds.fastMax, 3.4);
  const balancedMax = asNumber(thresholds.balancedMax, 6.4);
  const riskForceDeep = asNumber(guards.riskForceDeep, 9);
  const riskNoFast = asNumber(guards.riskNoFast, 7);
  const effort = effortScore(s, weights);

  let tier: Tier = "balanced";
  let guardrail: string | null = null;
  if (effort <= fastMax) {
    tier = "fast";
  } else if (effort > balancedMax) {
    tier = "deep";
  }
  if (s.latency >= 7 && s.risk <= 3 && s.complexity <= 3) {
    tier = "fast";
    guardrail = "latency_fast_path";
  }

  let minTier: Tier = "fast";
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

export function overrideToken(tier: Tier): string {
  return DEFAULT_OVERRIDE_TOKENS[tier];
}
