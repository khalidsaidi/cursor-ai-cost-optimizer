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
  const plugin = await import(require("url").pathToFileURL(path.join(PLUGIN, "scripts", "lib", "pricing.mjs")).href);
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
      fs.writeFileSync(path.join(ws, ".cursor", "agents", `${tier}-tier.md`), `---\nname: ${tier}-tier\nmodel: ${model}\n---\n`);
    }
    fs.writeFileSync(path.join(ws, ".cursor", "cco", "state", "decisions.jsonl"), [JSON.stringify({ estimateUsd: 0.01, chatEstimateUsd: 0.05 }), JSON.stringify({ estimateUsd: 0.02, chatEstimateUsd: null }), "not json", JSON.stringify({ estimateUsd: 0.5, chatEstimateUsd: 0.1 })].join("\n"));
    const s = P.readSavings(ws);
    assert.equal(s.decisions, 3);
    assert.ok(Math.abs(s.savedUsd - 0.04) < 1e-9 && Math.abs(s.estimatedUsd - 0.53) < 1e-9);

    // chat model unknown -> absolute prices
    let c = P.costStatement(ws, BUNDLED);
    assert.equal(c.chatModel, null);
    assert.match(c.lines[0].text, /^Fast → Composer 2\.5 · \$[0-9.]+\/M in, \$[0-9.]+\/M out$/);
    assert.match(c.lines[2].text, /^Deep → your chat model$/);
    assert.ok(c.warnings.includes("Deep tier has no model yet"));

    // latest session -> relative rates, Copilot wording
    fs.writeFileSync(path.join(ws, ".cursor", "cco", "state", "sessions", "a.json"), JSON.stringify({ model: "claude-opus-5-thinking-high", updatedAt: "2026-01-01T00:00:00Z" }));
    fs.writeFileSync(path.join(ws, ".cursor", "cco", "state", "sessions", "b.json"), JSON.stringify({ model: "auto", updatedAt: "2025-01-01T00:00:00Z" }));
    c = P.costStatement(ws, BUNDLED);
    assert.equal(c.chatModel, "claude-opus-5-thinking-high");
    assert.match(c.lines[0].text, /^Fast → Composer 2\.5 · [0-9.]+x the price of Claude Opus 5$/);
    assert.equal(P.costStatement(ws, BUNDLED, "auto").chatModelLabel, "Auto");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("readLastDecision: the tier comes from the subagent name suffix, whatever the naming scheme", () => {
  const { readLastDecision } = require("../../dist/pricing.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cco-last-"));
  const rows = [
    { ts: "1", final: "cco-deep", model: "claude-opus-5-thinking-high", estimateUsd: 0.5, chatEstimateUsd: 0.4 },
    { ts: "2", final: "composer-2.5-fast", model: "composer-2.5", estimateUsd: 0.02, chatEstimateUsd: 0.11 },
  ];
  fs.writeFileSync(path.join(dir, "decisions.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
  const last = readLastDecision(dir, dir);
  assert.equal(last.tier, "fast");
  assert.equal(last.model, "composer-2.5");
  assert.ok(Math.abs(last.savedUsd - 0.09) < 1e-9);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pickerModels: one row per model, plain id preferred, never a fast variant, cheapest first", () => {
  const { pickerModels, loadPricing } = require("../../dist/pricing.js");
  const pricing = loadPricing(null, path.join(__dirname, "..", "..", "resources", "plugin", "config", "pricing.json"));
  const ids = ["auto", "gpt-5.3-codex-low", "gpt-5.3-codex-low-fast", "gpt-5.3-codex", "gpt-5.3-codex-fast", "gpt-5.3-codex-high", "gpt-5.3-codex-xhigh-fast",
    "claude-opus-5-thinking-high", "claude-opus-5-thinking-high-fast", "claude-opus-5-low", "composer-2.5", "composer-2.5-fast", "cursor-grok-4.6-high-fast", "cursor-grok-4.6-high", "claude-sonnet-5-thinking-high"];
  const rows = pickerModels(ids, pricing);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.id]));
  assert.equal(byLabel["GPT-5.3 Codex"], "gpt-5.3-codex");
  assert.equal(byLabel["Composer 2.5"], "composer-2.5");
  assert.equal(byLabel["Grok 4.6"], "cursor-grok-4.6-high");
  assert.equal(rows.filter((r) => r.label === "GPT-5.3 Codex").length, 1);
  assert.equal(byLabel["Claude Opus 5"], "claude-opus-5-thinking-high", "the high effort variant when there is no plain id");
  assert.equal(byLabel["Composer 2.5 Fast"], "composer-2.5-fast", "fast variants are their own (2x) row");
  assert.equal(rows[0].label, "Composer 2.5", "cheapest first");
});

test("readSavings counts only real delegations, not tasks kept in the chat", () => {
  const { readSavings } = require("../../dist/pricing.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cco-sav-"));
  fs.writeFileSync(path.join(dir, "decisions.jsonl"), [
    JSON.stringify({ final: "composer-2.5-fast", estimateUsd: 0.02, chatEstimateUsd: 0.08 }),
    JSON.stringify({ final: "chat", reason: "tier_fast_not_cheaper_than_chat_model", estimateUsd: null, chatEstimateUsd: null }),
  ].join("\n"));
  const s = readSavings(dir, dir);
  assert.equal(s.decisions, 1);
  assert.ok(Math.abs(s.savedUsd - 0.06) < 1e-9);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("overrideMismatches: a typed tier model the account does not list is reported with the model actually used", () => {
  const { overrideMismatches } = require("../../dist/pricing.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cco-ovr-"));
  const rt = path.join(dir, "runtime.json");
  fs.writeFileSync(rt, JSON.stringify({ discovery: { overrides: { requested: { fast: "gpt-99-turbo", balanced: "", deep: "claude-opus-5-thinking-high" } } } }));
  const agents = { "fast-tier": "composer-2.5", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high" };
  assert.deepEqual(overrideMismatches(rt, agents), [{ tier: "fast", requested: "gpt-99-turbo", actual: "composer-2.5" }]);
  assert.deepEqual(overrideMismatches(path.join(dir, "missing.json"), agents), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readSavings takes a failed delegation (usage limit) back out of the figures", () => {
  const { readSavings } = require("../../dist/pricing.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cco-fail-"));
  fs.writeFileSync(path.join(dir, "decisions.jsonl"), [
    JSON.stringify({ conversation_id: "c1", final: "composer-2.5-fast", estimateUsd: 0.02, chatEstimateUsd: 0.08 }),
    JSON.stringify({ conversation_id: "c2", final: "claude-opus-5-deep", estimateUsd: 0.86, chatEstimateUsd: 0.9 }),
    JSON.stringify({ event: "subagent_failed", conversation_id: "c2", agent: "claude-opus-5-deep", status: "error" }),
  ].join("\n"));
  const s = readSavings(dir, dir);
  assert.equal(s.decisions, 1);
  assert.ok(Math.abs(s.savedUsd - 0.06) < 1e-9);
  fs.rmSync(dir, { recursive: true, force: true });
});
