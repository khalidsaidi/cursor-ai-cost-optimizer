/**
 * TypeScript port of the plugin's scripts/lib/pricing.mjs model-id → price resolution (parity-tested in
 * test/unit/pricing.test.js), plus the project-local readers the extension UI needs: the price table
 * (<ws>/.cursor/cco/pricing.json, fallback bundled), tier models from <ws>/.cursor/agents, the chat model of
 * the latest session, per-tier rate multipliers, and the estimated savings from decisions.jsonl.
 * No vscode imports.
 */
import * as fs from "fs";
import * as path from "path";

export interface PriceRow {
  name: string;
  provider?: string | null;
  input: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  output: number | null;
}
export interface PricingTable {
  schemaVersion?: number;
  fetchedAt: string | null;
  models: PriceRow[];
  loadedFrom: string | null;
}
export interface ResolvedPrice {
  input: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  output: number | null;
  matchedRow: string | null;
  provider: string | null;
  confidence: "override" | "estimate" | "id" | "label" | "unknown";
  note: string;
}

/** Documented fixed rate for Auto (estimate only; Auto bills at the routed model's list price). */
export const AUTO_ESTIMATE_RATE = { input: 1.25, cacheWrite: 1.25, cacheRead: 0.25, output: 6.0 };
const FAST_MULTIPLIER = 2;
const PARAM_TOKENS = new Set(["thinking", "low", "medium", "high", "xhigh", "max", "fast", "1m", "extra", "nozdr", "zdr", "no"]);
const VENDOR_TOKENS = new Set(["claude", "cursor", "openai", "google", "anthropic"]);
export const PRICING_STALE_DAYS = 7;

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function readJsonOr<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function normalizeName(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\(fast mode\)|\(fast\)/g, " fast ")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}
function tokenSet(text: unknown): string[] {
  return normalizeName(text)
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !PARAM_TOKENS.has(t))
    .filter((t) => !VENDOR_TOKENS.has(t));
}
function tokenKey(tokens: string[]): string {
  return [...tokens].sort().join(" ");
}
export function modelIdTokens(modelId: unknown): { tokens: string[]; fast: boolean } {
  const id = String(modelId ?? "").toLowerCase().replace(/\[.*$/, "");
  const parts = id.split(/[-_\s]+/).filter(Boolean);
  const fast = parts.includes("fast");
  const tokens = parts.filter((t) => !PARAM_TOKENS.has(t) && !VENDOR_TOKENS.has(t));
  return { tokens, fast };
}
function labelTokens(label: unknown): { tokens: string[]; fast: boolean } {
  return { tokens: tokenSet(label), fast: /\bfast\b/i.test(String(label ?? "")) };
}
function findRow(rows: PriceRow[], tokens: string[], wantFast: boolean): { row: PriceRow; fastRowUsed: boolean } | null {
  const key = tokenKey(tokens);
  const matches = rows.filter((row) => tokenKey(tokenSet(row.name)) === key);
  if (!matches.length) {
    return null;
  }
  const fastRows = matches.filter((row) => /fast/i.test(row.name));
  const plainRows = matches.filter((row) => !/fast/i.test(row.name));
  if (wantFast && fastRows.length) {
    return { row: fastRows[0], fastRowUsed: true };
  }
  if (plainRows.length) {
    return { row: plainRows[0], fastRowUsed: false };
  }
  return { row: matches[0], fastRowUsed: /fast/i.test(matches[0].name) };
}

/** <ws>/.cursor/cco/pricing.json when it has >= 5 rows, else the bundled table. */
export function loadPricing(workspacePricingPath: string | null, bundledPricingPath: string): PricingTable {
  for (const candidate of [workspacePricingPath, bundledPricingPath]) {
    if (!candidate) {
      continue;
    }
    const data = readJsonOr<Partial<PricingTable> | null>(candidate, null);
    if (data && Array.isArray(data.models) && data.models.length >= 5) {
      return { schemaVersion: data.schemaVersion, fetchedAt: data.fetchedAt ?? null, models: data.models, loadedFrom: candidate };
    }
  }
  return { schemaVersion: 2, fetchedAt: null, models: [], loadedFrom: null };
}

export function resolveModelPrice(modelId: unknown, pricing: PricingTable | null, options: { overrides?: Record<string, Partial<PriceRow>>; label?: string } = {}): ResolvedPrice {
  const id = String(modelId ?? "").trim();
  const rows = Array.isArray(pricing?.models) ? pricing!.models : [];
  const overrides = options.overrides || {};
  if (overrides[id]) {
    const o = overrides[id];
    return { input: asNumber(o.input, 0), cacheWrite: asNumber(o.cacheWrite, asNumber(o.input, 0)), cacheRead: asNumber(o.cacheRead, 0), output: asNumber(o.output, 0), matchedRow: "override", provider: o.provider || "override", confidence: "override", note: "user override from cco.json pricing.overrides" };
  }
  if (!id || id === "auto" || id.startsWith("auto")) {
    return { ...AUTO_ESTIMATE_RATE, matchedRow: "auto (estimate)", provider: "Cursor", confidence: "estimate", note: "Auto bills at the routed model's list price; fixed Auto rate used as an estimate" };
  }
  const { tokens, fast } = modelIdTokens(id);
  let match = findRow(rows, tokens, fast);
  let usedLabel = false;
  if (!match && options.label) {
    const lt = labelTokens(options.label);
    match = findRow(rows, lt.tokens, lt.fast || fast);
    usedLabel = Boolean(match);
  }
  if (!match) {
    return { input: null, cacheWrite: null, cacheRead: null, output: null, matchedRow: null, provider: null, confidence: "unknown", note: `no pricing row matched model id ${id}` };
  }
  const row = match.row;
  const multiplier = fast && !match.fastRowUsed ? FAST_MULTIPLIER : 1;
  const input = asNumber(row.input, 0);
  const cacheWrite = row.cacheWrite === null || row.cacheWrite === undefined ? input : asNumber(row.cacheWrite, 0);
  const cacheRead = row.cacheRead === null || row.cacheRead === undefined ? input : asNumber(row.cacheRead, 0);
  return { input: input * multiplier, cacheWrite: cacheWrite * multiplier, cacheRead: cacheRead * multiplier, output: asNumber(row.output, 0) * multiplier, matchedRow: row.name, provider: row.provider ?? null, confidence: usedLabel ? "label" : "id", note: multiplier > 1 ? "fast variant priced at 2x list (per Cursor docs)" : "" };
}

/** Same blend the plugin uses to compare models (mostly cached input, a little output). */
export function blendedRatePerMillion(price: ResolvedPrice | null): number | null {
  if (!price || !Number.isFinite(price.input as number)) {
    return null;
  }
  const inputShare = 25 / 26;
  const outputShare = 1 / 26;
  const effectiveInput = 0.15 * (price.input as number) + 0.85 * (price.cacheRead as number);
  return inputShare * effectiveInput + outputShare * (price.output as number);
}

/** Rate multiplier of `model` relative to `baseModel` (Copilot-style "0.1x"), or null when either is unpriced. */
export function rateMultiplier(model: string, baseModel: string, pricing: PricingTable): number | null {
  const a = blendedRatePerMillion(resolveModelPrice(model, pricing));
  const b = blendedRatePerMillion(resolveModelPrice(baseModel, pricing));
  if (a === null || b === null || b <= 0) {
    return null;
  }
  return a / b;
}
export function formatMultiplier(x: number): string {
  if (x >= 10) {
    return `${Math.round(x)}x`;
  }
  const rounded = x >= 1 ? Math.round(x * 10) / 10 : Math.round(x * 100) / 100;
  return `${rounded}x`;
}
export function formatUsd(x: number): string {
  return x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`;
}
export function pricingAgeDays(pricing: PricingTable): number | null {
  if (!pricing.fetchedAt) {
    return null;
  }
  const t = Date.parse(pricing.fetchedAt);
  return Number.isFinite(t) ? (Date.now() - t) / 86_400_000 : null;
}
export function pricingIsStale(pricing: PricingTable, maxDays = PRICING_STALE_DAYS): boolean {
  const age = pricingAgeDays(pricing);
  return age === null || age > maxDays;
}

// ---------------------------------------------------------------------------------------------
// project readers
// ---------------------------------------------------------------------------------------------

export const TIERS = ["fast", "balanced", "deep"] as const;
export type Tier = (typeof TIERS)[number];

export function readTierModels(workspace: string): Record<Tier, string | null> {
  const out = { fast: null, balanced: null, deep: null } as Record<Tier, string | null>;
  for (const tier of TIERS) {
    try {
      const text = fs.readFileSync(path.join(workspace, ".cursor", "agents", `cco-${tier}.md`), "utf8");
      const m = text.match(/^model:\s*(.+)$/m);
      out[tier] = m ? m[1].trim() : null;
    } catch {
      out[tier] = null;
    }
  }
  return out;
}

/** The chat model of the most recently updated session in <ws>/.cursor/cco/state/sessions (null when unknown). */
export function readLatestChatModel(workspace: string): string | null {
  const dir = path.join(workspace, ".cursor", "cco", "state", "sessions");
  let best: { model: string; ts: number } | null = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      const s = readJsonOr<{ model?: string; updatedAt?: string; startedAt?: string } | null>(path.join(dir, name), null);
      const model = String(s?.model || "").trim();
      const ts = Date.parse(s?.updatedAt || s?.startedAt || "") || 0;
      if (model && (!best || ts > best.ts)) {
        best = { model, ts };
      }
    }
  } catch {}
  return best ? best.model : null;
}

export interface Savings {
  decisions: number;
  savedUsd: number;
  estimatedUsd: number;
}
/** Σ max(0, chatEstimateUsd - estimateUsd) over <ws>/.cursor/cco/state/decisions.jsonl. */
export function readSavings(workspace: string): Savings {
  const out: Savings = { decisions: 0, savedUsd: 0, estimatedUsd: 0 };
  let text = "";
  try {
    text = fs.readFileSync(path.join(workspace, ".cursor", "cco", "state", "decisions.jsonl"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const d = JSON.parse(line) as { estimateUsd?: number | null; chatEstimateUsd?: number | null };
      out.decisions += 1;
      if (Number.isFinite(d.estimateUsd as number)) {
        out.estimatedUsd += d.estimateUsd as number;
        if (Number.isFinite(d.chatEstimateUsd as number)) {
          out.savedUsd += Math.max(0, (d.chatEstimateUsd as number) - (d.estimateUsd as number));
        }
      }
    } catch {}
  }
  return out;
}

export interface TierLine {
  tier: Tier;
  model: string | null;
  multiplier: number | null;
  price: ResolvedPrice | null;
  text: string;
}
export interface CostStatement {
  chatModel: string | null;
  chatModelLabel: string;
  pricing: PricingTable;
  stale: boolean;
  lines: TierLine[];
  warnings: string[];
}
/** Copilot-style per-tier cost lines: `FAST → composer-2.5 • 0.1x of <chat model>` or absolute $/M when the chat model is unknown. */
export function costStatement(workspace: string, bundledPricingPath: string, chatModelOverride?: string | null): CostStatement {
  const pricing = loadPricing(path.join(workspace, ".cursor", "cco", "pricing.json"), bundledPricingPath);
  const models = readTierModels(workspace);
  const chatModel = chatModelOverride === undefined ? readLatestChatModel(workspace) : chatModelOverride;
  const chatModelLabel = !chatModel ? "" : chatModel === "auto" ? "Auto" : chatModel;
  const stale = pricingIsStale(pricing);
  const warnings: string[] = [];
  if (stale) {
    warnings.push(pricing.fetchedAt ? `pricing.json is ${Math.round(pricingAgeDays(pricing) as number)} days old` : "no pricing.json yet");
  }
  const lines: TierLine[] = TIERS.map((tier) => {
    const model = models[tier];
    const label = tier.toUpperCase();
    if (!model || model === "inherit") {
      if (!model) {
        warnings.push(`cco-${tier} agent missing`);
      } else {
        warnings.push(`cco-${tier} is inherit`);
      }
      return { tier, model, multiplier: null, price: null, text: `${label} → ${model ?? "(no agent file)"}` };
    }
    const price = resolveModelPrice(model, pricing);
    if (chatModel) {
      const m = rateMultiplier(model, chatModel, pricing);
      return { tier, model, multiplier: m, price, text: m === null ? `${label} → ${model} • rate unknown` : `${label} → ${model} • ${formatMultiplier(m)} of ${chatModelLabel} (Rate is counted at ${formatMultiplier(m)}.)` };
    }
    return { tier, model, multiplier: null, price, text: Number.isFinite(price.input as number) ? `${label} → ${model} • $${price.input}/M in, $${price.output}/M out` : `${label} → ${model} • price unknown` };
  });
  return { chatModel, chatModelLabel, pricing, stale, lines, warnings: [...new Set(warnings)] };
}
