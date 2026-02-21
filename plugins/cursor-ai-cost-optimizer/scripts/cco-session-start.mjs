#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_REFRESH_HOURS = 24;
const DEFAULT_SOURCE_URL = "https://cursor.com/docs/account/pricing";

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      resolve(raw);
    });
  });
}

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {}
}

function appendJsonl(filePath, payload) {
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {}
}

function firstWorkspaceRoot(payload) {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) {
    return roots[0];
  }
  return null;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function asPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function ageHours(iso) {
  if (!iso) {
    return Number.POSITIVE_INFINITY;
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return Number.POSITIVE_INFINITY;
  }
  return (Date.now() - t) / (1000 * 60 * 60);
}

async function fetchText(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "cursor-ai-cost-optimizer/0.1.2"
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractRate(block, labelRegex) {
  const amountRegex = /([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/;
  const scoped = new RegExp(`${labelRegex.source}[\\s\\S]{0,220}?\\$\\s*${amountRegex.source}`, "i");
  const match = block.match(scoped);
  if (!match || !match[1]) {
    return null;
  }
  const normalized = match[1].replace(/,/g, "");
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

function parsePricingRatesUsdPer1M(doc) {
  const compact = String(doc).replace(/\s+/g, " ");
  const autoIndex = compact.toLowerCase().indexOf("auto api rates");
  const scoped = autoIndex >= 0 ? compact.slice(autoIndex, autoIndex + 3500) : compact;

  const inputCacheWrite =
    extractRate(scoped, /Input\s*\+\s*Cache\s*Write/i) ||
    extractRate(compact, /Input\s*\+\s*Cache\s*Write/i);
  const output = extractRate(scoped, /Output/i) || extractRate(compact, /Output/i);
  const cacheRead =
    extractRate(scoped, /Cache\s*Read/i) || extractRate(compact, /Cache\s*Read/i);

  if (!Number.isFinite(inputCacheWrite) || !Number.isFinite(output) || !Number.isFinite(cacheRead)) {
    throw new Error("Could not parse Auto API rates from Cursor pricing page.");
  }

  return {
    inputCacheWrite,
    output,
    cacheRead
  };
}

function toPerToken(ratePer1M) {
  return Number((ratePer1M / 1_000_000).toPrecision(12));
}

function hasValidRates(rates) {
  if (!rates || typeof rates !== "object") {
    return false;
  }
  const values = [rates.inputCacheWrite, rates.output, rates.cacheRead];
  return values.every((value) => Number.isFinite(Number(value)) && Number(value) >= 0);
}

function buildPricingPayload({
  fetchedAt,
  sourceUrl,
  refreshHours,
  ratesUsdPer1M,
  staleFallbackUsed
}) {
  return {
    schemaVersion: 1,
    fetchedAt,
    source: {
      type: "cursor_docs_pricing",
      url: sourceUrl
    },
    refreshPolicy: {
      refreshHours
    },
    autoApiRatesUsdPer1MTokens: ratesUsdPer1M,
    autoApiRatesUsdPerToken: {
      inputCacheWrite: toPerToken(ratesUsdPer1M.inputCacheWrite),
      output: toPerToken(ratesUsdPer1M.output),
      cacheRead: toPerToken(ratesUsdPer1M.cacheRead)
    },
    staleFallbackUsed: Boolean(staleFallbackUsed)
  };
}

async function main() {
  const stdin = await readStdin();
  const payload = safeJsonParse(stdin.trim() || "{}");

  const workspace = firstWorkspaceRoot(payload) ?? process.cwd();
  const cursorDir = path.join(workspace, ".cursor");
  const aiDir = path.join(workspace, ".ai", "cco");
  ensureDir(cursorDir);
  ensureDir(aiDir);

  const config = readJsonSafe(path.join(cursorDir, "cco.json")) || {};
  const pricingCfg = config?.pricing || {};
  const enabled = pricingCfg.enabled !== false;
  const refreshHours = asPositiveNumber(
    process.env.CCO_PRICING_REFRESH_HOURS ?? pricingCfg.refreshHours,
    DEFAULT_REFRESH_HOURS
  );
  const sourceUrl =
    typeof pricingCfg.sourceUrl === "string" && pricingCfg.sourceUrl.trim()
      ? pricingCfg.sourceUrl.trim()
      : DEFAULT_SOURCE_URL;

  const pricingPath = path.join(cursorDir, "cco-pricing.json");
  const logPath = path.join(aiDir, "hook-session-start.jsonl");
  const existing = readJsonSafe(pricingPath);
  const existingAgeHours = ageHours(existing?.fetchedAt);
  const existingHasRates = hasValidRates(existing?.autoApiRatesUsdPer1MTokens);
  const nowIso = new Date().toISOString();

  if (!enabled) {
    appendJsonl(logPath, {
      ts: nowIso,
      event: "sessionStart",
      pricingRefresh: "disabled",
      pricingPath
    });
    console.log(
      JSON.stringify({
        continue: true,
        pricingRefresh: "disabled",
        pricingPath
      })
    );
    return;
  }

  if (existing && existingHasRates && Number.isFinite(existingAgeHours) && existingAgeHours < refreshHours) {
    appendJsonl(logPath, {
      ts: nowIso,
      event: "sessionStart",
      pricingRefresh: "cached",
      ageHours: Number(existingAgeHours.toFixed(2)),
      refreshHours,
      pricingPath
    });
    console.log(
      JSON.stringify({
        continue: true,
        pricingRefresh: "cached",
        ageHours: Number(existingAgeHours.toFixed(2)),
        refreshHours,
        pricingPath
      })
    );
    return;
  }

  try {
    const doc = await fetchText(sourceUrl);
    const rates = parsePricingRatesUsdPer1M(doc);
    const pricing = buildPricingPayload({
      fetchedAt: nowIso,
      sourceUrl,
      refreshHours,
      ratesUsdPer1M: rates,
      staleFallbackUsed: false
    });
    fs.writeFileSync(pricingPath, `${JSON.stringify(pricing, null, 2)}\n`, "utf8");

    appendJsonl(logPath, {
      ts: nowIso,
      event: "sessionStart",
      pricingRefresh: "refreshed",
      refreshHours,
      sourceUrl,
      pricingPath
    });
    console.log(
      JSON.stringify({
        continue: true,
        pricingRefresh: "refreshed",
        refreshHours,
        pricingPath,
        sourceUrl
      })
    );
    return;
  } catch (error) {
    const message = String(error?.message || error);
    if (!existing) {
      const fallback = {
        schemaVersion: 1,
        fetchedAt: nowIso,
        source: {
          type: "cursor_docs_pricing",
          url: sourceUrl
        },
        refreshPolicy: {
          refreshHours
        },
        autoApiRatesUsdPer1MTokens: null,
        autoApiRatesUsdPerToken: null,
        staleFallbackUsed: true,
        error: message
      };
      fs.writeFileSync(pricingPath, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
    }

    appendJsonl(logPath, {
      ts: nowIso,
      event: "sessionStart",
      pricingRefresh: "failed",
      keptExisting: Boolean(existing),
      error: message.slice(0, 500),
      pricingPath
    });
    console.log(
      JSON.stringify({
        continue: true,
        pricingRefresh: "failed",
        keptExisting: Boolean(existing),
        pricingPath,
        error: message
      })
    );
  }
}

main();
