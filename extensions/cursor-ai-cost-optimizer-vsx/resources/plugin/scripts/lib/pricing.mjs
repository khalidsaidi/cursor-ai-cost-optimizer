import path from "node:path";
import { PLUGIN_ROOT, readJsonSafe, asNumber } from "./common.mjs";

export const PRICING_SOURCE_URL = "https://cursor.com/docs/models-and-pricing.md";
export const BUNDLED_PRICING_PATH = path.join(PLUGIN_ROOT, "config", "pricing.json");

/**
 * What Cursor bills an Auto request at, per million tokens. Fitted exactly (8 of 8 billed requests, 2026-09-05,
 * Pro plan, cursor.com/dashboard usage events) to $2.00 input, $0.50 cache read, $6.00 output; cache write is not
 * observable there and is taken as the input rate. Auto is billed at this one rate whatever model it picked.
 */
export const AUTO_RATE = {
  input: 2.0,
  cacheWrite: 2.0,
  cacheRead: 0.5,
  output: 6.0
};
export const AUTO_ESTIMATE_RATE = AUTO_RATE;

const FAST_MULTIPLIER = 2;
const PARAM_TOKENS = new Set([
  "thinking",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "fast",
  "1m",
  "extra",
  "nozdr",
  "zdr",
  "no"
]);
const VENDOR_TOKENS = new Set(["claude", "cursor", "openai", "google", "anthropic"]);

function parseMoney(cell) {
  const text = String(cell ?? "").trim();
  if (!text || text === "-" || text === "—") {
    return null;
  }
  const match = text.replace(/,/g, "").match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function stripLinks(text) {
  return String(text ?? "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
}

/** Parse the markdown pricing tables from cursor.com/docs/models-and-pricing.md. */
export function parsePricingMarkdown(markdown) {
  const rows = [];
  let header = null;
  for (const rawLine of String(markdown ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) {
      header = null;
      continue;
    }
    const cells = line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 6) {
      continue;
    }
    if (cells[0].toLowerCase() === "model") {
      header = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    if (/^-{2,}$/.test(cells[0].replace(/\s/g, ""))) {
      continue;
    }
    if (!header) {
      continue;
    }
    const col = (name) => {
      const index = header.indexOf(name);
      return index >= 0 ? cells[index] : undefined;
    };
    const name = stripLinks(cells[0]);
    const input = parseMoney(col("input"));
    const output = parseMoney(col("output"));
    if (!name || input === null || output === null) {
      continue;
    }
    rows.push({
      name,
      provider: stripLinks(col("provider") || ""),
      input,
      cacheWrite: parseMoney(col("cache write")),
      cacheRead: parseMoney(col("cache read")),
      output,
      notes: stripLinks(col("notes") || "")
    });
  }
  return rows;
}

export function normalizeName(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\(fast mode\)|\(fast\)/g, " fast ")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

function tokenSet(text) {
  const tokens = normalizeName(text)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !PARAM_TOKENS.has(token))
    .filter((token) => !VENDOR_TOKENS.has(token));
  return tokens;
}

function tokenKey(tokens) {
  return [...tokens].sort().join(" ");
}

/** Convert a CLI model id (e.g. `claude-opus-5-thinking-high-fast`) into match tokens. */
export function modelIdTokens(modelId) {
  const id = String(modelId ?? "").toLowerCase().replace(/\[.*$/, "");
  const parts = id.split(/[-_\s]+/).filter(Boolean);
  const fast = parts.includes("fast");
  const tokens = parts.filter((token) => !PARAM_TOKENS.has(token) && !VENDOR_TOKENS.has(token));
  return { tokens, fast };
}

function labelTokens(label) {
  const fast = /\bfast\b/i.test(String(label ?? ""));
  return { tokens: tokenSet(label), fast };
}

export function loadPricing(workspacePricingPath) {
  const candidates = [workspacePricingPath, BUNDLED_PRICING_PATH].filter(Boolean);
  for (const candidate of candidates) {
    const data = readJsonSafe(candidate);
    if (data && Array.isArray(data.models) && data.models.length >= 5) {
      return { ...data, loadedFrom: candidate };
    }
  }
  return { schemaVersion: 2, fetchedAt: null, models: [], loadedFrom: null };
}

function findRow(rows, tokens, wantFast) {
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

/**
 * Resolve per-1M-token prices for a Cursor CLI model id.
 * Returns { input, cacheWrite, cacheRead, output, matchedRow, provider, confidence, note }.
 */
export function resolveModelPrice(modelId, pricing, options = {}) {
  const id = String(modelId ?? "").trim();
  const rows = Array.isArray(pricing?.models) ? pricing.models : [];
  const overrides = options.overrides || {};
  if (overrides[id]) {
    const o = overrides[id];
    return {
      input: asNumber(o.input, 0),
      cacheWrite: asNumber(o.cacheWrite, asNumber(o.input, 0)),
      cacheRead: asNumber(o.cacheRead, 0),
      output: asNumber(o.output, 0),
      matchedRow: "override",
      provider: o.provider || "override",
      confidence: "override",
      note: "user override from cco.json pricing.overrides"
    };
  }
  if (!id || id === "auto" || id.startsWith("auto")) {
    return {
      ...AUTO_RATE,
      matchedRow: "auto (measured)",
      provider: "Cursor",
      confidence: "measured",
      note: "Auto is billed at one fixed rate whatever model it picked (fitted to billed usage events)"
    };
  }

  let match = null;
  let usedLabel = false;
  const { tokens, fast } = modelIdTokens(id);
  match = findRow(rows, tokens, fast);
  if (!match && options.label) {
    const lt = labelTokens(options.label);
    match = findRow(rows, lt.tokens, lt.fast || fast);
    usedLabel = Boolean(match);
  }
  if (!match) {
    return {
      input: null,
      cacheWrite: null,
      cacheRead: null,
      output: null,
      matchedRow: null,
      provider: null,
      confidence: "unknown",
      note: `no pricing row matched model id ${id}`
    };
  }

  const row = match.row;
  const multiplier = fast && !match.fastRowUsed ? FAST_MULTIPLIER : 1;
  const cacheWrite = row.cacheWrite === null ? row.input : row.cacheWrite;
  const cacheRead = row.cacheRead === null ? row.input : row.cacheRead;
  return {
    input: row.input * multiplier,
    cacheWrite: cacheWrite * multiplier,
    cacheRead: cacheRead * multiplier,
    output: row.output * multiplier,
    matchedRow: row.name,
    provider: row.provider,
    confidence: usedLabel ? "label" : "id",
    note: multiplier > 1 ? "fast variant priced at 2x list (per Cursor docs)" : ""
  };
}

/** Cost in USD for a usage object from cursor-agent stream-json / json output. */
export function usageCostUsd(usage, price, options = {}) {
  if (!usage || !price || !Number.isFinite(price.input)) {
    return null;
  }
  const input = asNumber(usage.inputTokens, 0);
  const output = asNumber(usage.outputTokens, 0);
  const cacheRead = asNumber(usage.cacheReadTokens, 0);
  const cacheWrite = asNumber(usage.cacheWriteTokens, 0);
  let usd =
    (input * price.input +
      output * price.output +
      cacheRead * price.cacheRead +
      cacheWrite * price.cacheWrite) /
    1_000_000;
  if (options.tokenRatePerMillion && price.provider && !/cursor/i.test(price.provider)) {
    usd += ((input + output + cacheRead + cacheWrite) * options.tokenRatePerMillion) / 1_000_000;
  }
  return usd;
}

/** Rough blended $/1M for ranking models: assumes ~85% of input is cache reads and a 25:1 input:output ratio. */
export function blendedRatePerMillion(price) {
  if (!price || !Number.isFinite(price.input)) {
    return null;
  }
  const inputShare = 25 / 26;
  const outputShare = 1 / 26;
  const effectiveInput = 0.15 * price.input + 0.85 * price.cacheRead;
  return inputShare * effectiveInput + outputShare * price.output;
}
