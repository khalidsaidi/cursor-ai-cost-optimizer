#!/usr/bin/env node
/**
 * Refresh the per-model price table from Cursor's official docs (markdown endpoint).
 *
 *   node scripts/cco-refresh-pricing.mjs --workspace <root>   # writes .cursor/cco-pricing.json
 *   node scripts/cco-refresh-pricing.mjs --bundle             # updates config/pricing.json (maintainers)
 *   node scripts/cco-refresh-pricing.mjs --from <file.md>     # parse a local markdown copy
 */
import path from "node:path";
import { readTextSafe, writeJson, nowIso, parseArgs, workspacePaths, PLUGIN_ROOT, isMain } from "./lib/common.mjs";
import { parsePricingMarkdown, PRICING_SOURCE_URL, BUNDLED_PRICING_PATH } from "./lib/pricing.mjs";

export async function fetchText(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "cursor-ai-cost-optimizer/0.2 (+https://github.com/khalidsaidi/cursor-ai-cost-optimizer)" }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function buildPricingPayload({ rows, sourceUrl, fetchedAt }) {
  return {
    schemaVersion: 2,
    fetchedAt,
    source: { type: "cursor_docs_models_and_pricing_md", url: sourceUrl },
    unit: "usd_per_1m_tokens",
    models: rows
  };
}

export async function refreshPricing({ sourceUrl = PRICING_SOURCE_URL, fromFile = null } = {}) {
  const markdown = fromFile ? readTextSafe(fromFile) : await fetchText(sourceUrl);
  if (!markdown) {
    throw new Error(fromFile ? `cannot read ${fromFile}` : "empty response");
  }
  const rows = parsePricingMarkdown(markdown);
  if (rows.length < 10) {
    throw new Error(`parsed only ${rows.length} pricing rows; refusing to overwrite`);
  }
  return buildPricingPayload({ rows, sourceUrl: fromFile ? `file://${path.resolve(fromFile)}` : sourceUrl, fetchedAt: nowIso() });
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { workspace: null, bundle: false, from: null, source: PRICING_SOURCE_URL });
  const payload = await refreshPricing({ sourceUrl: args.source, fromFile: args.from });
  const targets = [];
  if (args.bundle) {
    targets.push(BUNDLED_PRICING_PATH);
  }
  if (args.workspace) {
    targets.push(workspacePaths(path.resolve(String(args.workspace))).pricingPath);
  }
  if (!targets.length) {
    targets.push(BUNDLED_PRICING_PATH);
  }
  for (const target of targets) {
    writeJson(target, payload);
  }
  console.log(JSON.stringify({ ok: true, rows: payload.models.length, fetchedAt: payload.fetchedAt, wrote: targets, pluginRoot: PLUGIN_ROOT }, null, 2));
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    process.exit(1);
  });
}
