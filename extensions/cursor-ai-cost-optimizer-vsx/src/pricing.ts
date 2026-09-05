/**
 * TypeScript port of the plugin's scripts/lib/pricing.mjs model-id → price resolution (parity-tested in
 * test/unit/pricing.test.js), plus the project-local readers the extension UI needs: the price table
 * (<ws>/.cursor/cco/pricing.json, fallback bundled), tier models from <ws>/.cursor/agents, the chat model of
 * the latest session, per-tier rate multipliers, and the estimated savings from decisions.jsonl.
 * No vscode imports.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Text of an unknown value: strings pass through, everything else becomes "". */
function asText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

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
  return asText(text)
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
  const id = asText(modelId).toLowerCase().replace(/\[.*$/, "");
  const parts = id.split(/[-_\s]+/).filter(Boolean);
  const fast = parts.includes("fast");
  const tokens = parts.filter((t) => !PARAM_TOKENS.has(t) && !VENDOR_TOKENS.has(t));
  return { tokens, fast };
}
function labelTokens(label: unknown): { tokens: string[]; fast: boolean } {
  return { tokens: tokenSet(label), fast: /\bfast\b/i.test(asText(label)) };
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
  const id = asText(modelId).trim();
  const rows = Array.isArray(pricing?.models) ? pricing.models : [];
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
  if (!price || !Number.isFinite(price.input)) {
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

export function readTierModels(workspace: string, agentsDir?: string, namesFile?: string): Record<Tier, string | null> {
  const out = { fast: null, balanced: null, deep: null } as Record<Tier, string | null>;
  let names: Record<string, unknown> = {};
  try {
    names = JSON.parse(fs.readFileSync(namesFile ?? path.join(workspace, ".cursor", "cco", "agent-names.json"), "utf8")) as Record<string, unknown>;
  } catch {
    names = {};
  }
  for (const tier of TIERS) {
    try {
      const role = `${tier}-tier`;
      const file = typeof names[role] === "string" && names[role] ? String(names[role]) : role;
      const text = fs.readFileSync(path.join(agentsDir ?? path.join(workspace, ".cursor", "agents"), `${file}.md`), "utf8");
      const m = text.match(/^model:\s*(.+)$/m);
      out[tier] = m ? m[1].trim() : null;
    } catch {
      out[tier] = null;
    }
  }
  return out;
}

/** The chat model of the most recently updated session in <ws>/.cursor/cco/state/sessions (null when unknown). */
export function readLatestChatModel(workspace: string, stateDir?: string): string | null {
  const dir = path.join(stateDir ?? path.join(workspace, ".cursor", "cco", "state"), "sessions");
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
export function readSavings(workspace: string, stateDir?: string): Savings {
  const out: Savings = { decisions: 0, savedUsd: 0, estimatedUsd: 0 };
  let text = "";
  try {
    text = fs.readFileSync(path.join(stateDir ?? path.join(workspace, ".cursor", "cco", "state"), "decisions.jsonl"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const d = JSON.parse(line) as { final?: string; estimateUsd?: number | null; chatEstimateUsd?: number | null };
      if (d.final === "chat") {
        continue; // kept in the chat: not a routed task
      }
      out.decisions += 1;
      if (Number.isFinite(d.estimateUsd)) {
        out.estimatedUsd += d.estimateUsd as number;
        if (Number.isFinite(d.chatEstimateUsd)) {
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
export interface CostStatementOptions {
  chatModelOverride?: string | null;
  /** User scope: the extension's private state root (pricing.json, workspaces/<slug>/state) and ~/.cursor/agents. */
  stateRoot?: string;
  workspaceStateDir?: string;
}
export function costStatement(workspace: string, bundledPricingPath: string, optionsOrChatModel?: CostStatementOptions | string | null): CostStatement {
  const o: CostStatementOptions = typeof optionsOrChatModel === "object" && optionsOrChatModel !== null ? optionsOrChatModel : { chatModelOverride: optionsOrChatModel };
  const pricing = loadPricing(o.stateRoot ? path.join(o.stateRoot, "pricing.json") : path.join(workspace, ".cursor", "cco", "pricing.json"), bundledPricingPath);
  const models = readTierModels(workspace, o.stateRoot ? path.join(os.homedir(), ".cursor", "agents") : undefined, o.stateRoot ? path.join(o.stateRoot, "agent-names.json") : undefined);
  const chatModel = o.chatModelOverride === undefined ? readLatestChatModel(workspace, o.workspaceStateDir) : o.chatModelOverride;
  const chatModelLabel = !chatModel ? "" : modelDisplayName(chatModel, pricing);
  const stale = pricingIsStale(pricing);
  const warnings: string[] = [];
  if (stale) {
    warnings.push(pricing.fetchedAt ? `pricing.json is ${Math.round(pricingAgeDays(pricing) as number)} days old` : "no pricing.json yet");
  }
  const lines: TierLine[] = TIERS.map((tier) => {
    const model = models[tier];
    const label = tier === "fast" ? "Fast" : tier === "balanced" ? "Balanced" : "Deep";
    if (!model || model === "inherit") {
      warnings.push(`${label} tier has no model yet`);
      return { tier, model, multiplier: null, price: null, text: `${label} → ${model ? "your chat model" : "not set up"}` };
    }
    const price = resolveModelPrice(model, pricing);
    const name = modelDisplayName(model, pricing);
    if (chatModel) {
      const m = rateMultiplier(model, chatModel, pricing);
      const rel = m === null ? "rate unknown" : m < 0.995 ? `${formatMultiplier(m)} the price of ${chatModelLabel}` : m > 1.005 ? `${formatMultiplier(m)} the price of ${chatModelLabel}` : `same price as ${chatModelLabel}`;
      return { tier, model, multiplier: m, price, text: `${label} → ${name} · ${rel}` };
    }
    return { tier, model, multiplier: null, price, text: Number.isFinite(price.input) ? `${label} → ${name} · $${price.input}/M in, $${price.output}/M out` : `${label} → ${name} · price unknown` };
  });
  return { chatModel, chatModelLabel, pricing, stale, lines, warnings: [...new Set(warnings)] };
}

/** "Claude Sonnet 5", "Composer 2.5", "Grok 4.6": the price table's row name when the id matches one, else a tidied id. */
export function modelDisplayName(modelId: string, pricing: PricingTable | null): string {
  if (!modelId || modelId === "inherit") {
    return "the chat model";
  }
  if (/^auto$/i.test(modelId)) {
    return "Auto";
  }
  const price = resolveModelPrice(modelId, pricing);
  if (price.matchedRow) {
    return price.matchedRow.replace(/\s*\(Fast\)\s*$/i, " Fast");
  }
  return modelId
    .replace(/^cursor-/, "")
    .split("-")
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\bGpt\b/g, "GPT");
}

export interface LastDecision {
  ts: string;
  tier: string;
  model: string;
  estimateUsd: number | null;
  savedUsd: number | null;
}

/** The most recent routed task (last line of decisions.jsonl), for the status bar receipt. */
export function readLastDecision(workspace: string, stateDir?: string): LastDecision | null {
  let text = "";
  try {
    text = fs.readFileSync(path.join(stateDir ?? path.join(workspace, ".cursor", "cco", "state"), "decisions.jsonl"), "utf8");
  } catch {
    return null;
  }
  const lines = text.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const d = JSON.parse(lines[i]) as { ts?: string; final?: string; model?: string; estimateUsd?: number | null; chatEstimateUsd?: number | null };
      if (!d.final || d.final === "chat") {
        continue;
      }
      // model-named subagents (composer-2.5-fast), role names (fast-tier) and pre-0.3 names (cco-fast) all end in the tier
      const m = /(fast|balanced|deep)(?:-tier)?$/.exec(String(d.final));
      const tier = m ? m[1] : String(d.final);
      const saved = typeof d.estimateUsd === "number" && typeof d.chatEstimateUsd === "number" && d.chatEstimateUsd > d.estimateUsd ? d.chatEstimateUsd - d.estimateUsd : null;
      return { ts: String(d.ts ?? ""), tier, model: String(d.model ?? ""), estimateUsd: typeof d.estimateUsd === "number" ? d.estimateUsd : null, savedUsd: saved };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * One row per model for the pickers. An account lists every effort level and fast variant as its own id
 * (a real account: 250 ids, eight of them "GPT-5.3 Codex"); the picker shows each model once, on its plain
 * id (no effort suffix, never the 2x "fast" variant), cheapest first.
 */
export function pickerModels(ids: string[], pricing: PricingTable | null): Array<{ id: string; label: string; rate: number | null }> {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    if (!id || /^auto$/i.test(id)) {
      continue;
    }
    const label = modelDisplayName(id, pricing);
    groups.set(label, [...(groups.get(label) ?? []), id]);
  }
  const rank = (id: string): number => {
    const parts = String(id).toLowerCase().split("-");
    const effort = parts.filter((t) => /^(none|minimal|low|medium|high|xhigh|extra|max|thinking)$/.test(t));
    let score = modelIdTokens(id).fast ? 100 : 0;
    score += effort.length === 0 ? 0 : effort.includes("high") && !effort.includes("xhigh") ? 1 : effort.includes("medium") ? 2 : 3;
    return score;
  };
  const rows: Array<{ id: string; label: string; rate: number | null }> = [];
  for (const [label, members] of groups) {
    const id = [...members].sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))[0];
    rows.push({ id, label, rate: blendedRatePerMillion(resolveModelPrice(id, pricing)) });
  }
  return rows.sort((a, b) => (a.rate ?? Number.MAX_VALUE) - (b.rate ?? Number.MAX_VALUE) || a.label.localeCompare(b.label));
}

/**
 * A tier model the user typed in Settings that the account does not list is skipped by the mapping (best effort),
 * which must not stay silent: the tier keeps its automatic model and the user is told which id was not found.
 */
export function overrideMismatches(runtimePath: string, agents: Record<string, string | null>): Array<{ tier: Tier; requested: string; actual: string | null }> {
  let requested: Record<string, string> = {};
  try {
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as { discovery?: { overrides?: { requested?: Record<string, string> } } };
    requested = runtime.discovery?.overrides?.requested ?? {};
  } catch {
    return [];
  }
  const out: Array<{ tier: Tier; requested: string; actual: string | null }> = [];
  for (const tier of TIERS) {
    const want = String(requested[tier] ?? "").trim();
    if (!want) {
      continue;
    }
    const actual = agents[`${tier}-tier`] ?? null;
    if (actual !== want) {
      out.push({ tier, requested: want, actual });
    }
  }
  return out;
}
