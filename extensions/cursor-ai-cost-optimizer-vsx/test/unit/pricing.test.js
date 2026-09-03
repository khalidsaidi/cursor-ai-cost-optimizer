// Parity of the TS pricing port with the plugin's scripts/lib/pricing.mjs, plus the project readers.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const P = require("../../dist/pricing.js");
const ROOT = path.resolve(__dirname, "../..");
const PLUGIN = path.join(ROOT, "resources", "plugin");
const BUNDLED = path.join(PLUGIN, "config", "pricing.json");

test("resolveModelPrice / blendedRate match the plugin implementation for many ids", async () => {
  const plugin = await import(path.join(PLUGIN, "scripts", "lib", "pricing.mjs"));
  const table = P.loadPricing(null, BUNDLED);
  const ids = ["auto", "composer-2.5", "composer-2.5-fast", "claude-sonnet-5-thinking-high", "claude-opus-5-thinking-high", "cursor-grok-4.6-high", "cursor-grok-4.6-xhigh-fast", "gpt-5.6-codex-high", "gemini-3.8-flash", "kimi-k3-code", "totally-unknown-model", ...table.models.slice(0, 40).map((m) => plugin.normalizeName(m.name).replace(/\s+/g, "-"))];
  for (const id of ids) {
    const ours = P.resolveModelPrice(id, table);
    const theirs = plugin.resolveModelPrice(id, table);
    assert.deepEqual({ i: ours.input, cw: ours.cacheWrite, cr: ours.cacheRead, o: ours.output, row: ours.matchedRow, c: ours.confidence }, { i: theirs.input, cw: theirs.cacheWrite, cr: theirs.cacheRead, o: theirs.output, row: theirs.matchedRow, c: theirs.confidence }, id);
    assert.equal(P.blendedRatePerMillion(ours), plugin.blendedRatePerMillion(theirs), `blended ${id}`);
  }
});

test("rate multipliers, staleness, savings and the cost statement", () => {
  const table = P.loadPricing(null, BUNDLED);
  const m = P.rateMultiplier("composer-2.5", "claude-opus-5-thinking-high", table);
  assert.ok(m !== null && m > 0 && m < 1, `fast tier should be cheaper than opus, got ${m}`);
  assert.match(P.formatMultiplier(0.1234), /^0\.12x$/);
  assert.equal(P.formatMultiplier(1.26), "1.3x");
  assert.equal(P.rateMultiplier("totally-unknown", "auto", table), null);
  assert.equal(P.pricingIsStale({ fetchedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), models: [], loadedFrom: null }), true);
  assert.equal(P.pricingIsStale({ fetchedAt: new Date().toISOString(), models: [], loadedFrom: null }), false);

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-price-"));
  try {
    fs.mkdirSync(path.join(ws, ".cursor", "agents"), { recursive: true });
    fs.mkdirSync(path.join(ws, ".cursor", "cco", "state", "sessions"), { recursive: true });
    for (const [tier, model] of [["fast", "composer-2.5"], ["balanced", "claude-sonnet-5-thinking-high"], ["deep", "inherit"]]) {
      fs.writeFileSync(path.join(ws, ".cursor", "agents", `cco-${tier}.md`), `---\nname: cco-${tier}\nmodel: ${model}\n---\n`);
    }
    fs.writeFileSync(path.join(ws, ".cursor", "cco", "state", "decisions.jsonl"), [JSON.stringify({ estimateUsd: 0.01, chatEstimateUsd: 0.05 }), JSON.stringify({ estimateUsd: 0.02, chatEstimateUsd: null }), "not json", JSON.stringify({ estimateUsd: 0.5, chatEstimateUsd: 0.1 })].join("\n"));
    const s = P.readSavings(ws);
    assert.equal(s.decisions, 3);
    assert.ok(Math.abs(s.savedUsd - 0.04) < 1e-9 && Math.abs(s.estimatedUsd - 0.53) < 1e-9);

    // chat model unknown -> absolute prices
    let c = P.costStatement(ws, BUNDLED);
    assert.equal(c.chatModel, null);
    assert.match(c.lines[0].text, /^FAST → composer-2\.5 • \$[0-9.]+\/M in, \$[0-9.]+\/M out$/);
    assert.match(c.lines[2].text, /^DEEP → inherit$/);
    assert.ok(c.warnings.includes("cco-deep is inherit"));

    // latest session -> relative rates, Copilot wording
    fs.writeFileSync(path.join(ws, ".cursor", "cco", "state", "sessions", "a.json"), JSON.stringify({ model: "claude-opus-5-thinking-high", updatedAt: "2026-01-01T00:00:00Z" }));
    fs.writeFileSync(path.join(ws, ".cursor", "cco", "state", "sessions", "b.json"), JSON.stringify({ model: "auto", updatedAt: "2025-01-01T00:00:00Z" }));
    c = P.costStatement(ws, BUNDLED);
    assert.equal(c.chatModel, "claude-opus-5-thinking-high");
    assert.match(c.lines[0].text, /^FAST → composer-2\.5 • [0-9.]+x of claude-opus-5-thinking-high \(Rate is counted at [0-9.]+x\.\)$/);
    assert.equal(P.costStatement(ws, BUNDLED, "auto").chatModelLabel, "Auto");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
