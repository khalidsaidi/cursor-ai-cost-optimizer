// Parity tests for the TypeScript port of the plugin scorer (run after `npm run compile`).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { heuristicScores, decideTier, parseOverride, effortScore, DEFAULT_CONFIG } = require("../../dist/scorer.js");

const RESOURCES = path.resolve(__dirname, "../../resources");
const config = JSON.parse(fs.readFileSync(path.join(RESOURCES, "plugin", "config", "defaults.json"), "utf8"));

test("bundled defaults match the hard-coded scorer defaults", () => {
  assert.deepEqual(config.weights, DEFAULT_CONFIG.weights);
  assert.deepEqual(config.thresholds, DEFAULT_CONFIG.thresholds);
  assert.deepEqual(config.guardrails, DEFAULT_CONFIG.guardrails);
});

test("override tokens are detected anywhere, last one wins", () => {
  assert.equal(parseOverride("please [cco:deep] do this"), "deep");
  assert.equal(parseOverride("[cco:fast] then later [cco:balanced]"), "balanced");
  assert.equal(parseOverride("no token here"), null);
  assert.equal(parseOverride("[CCO:AUTO]"), "auto");
});

test("heuristics: quick question is FAST, production auth work is not", () => {
  const quick = heuristicScores("quick: what git command shows the last 3 commits?");
  assert.equal(decideTier({ scores: quick, config }).tier, "fast");

  const risky = heuristicScores("Rotate the production OAuth secrets and update the payment webhook signature verification across the services");
  const decision = decideTier({ scores: risky, config });
  assert.ok(risky.risk >= 7, `risk should be high, got ${risky.risk}`);
  assert.notEqual(decision.tier, "fast");
});

test("guardrails: risk>=9 forces deep unless overridden", () => {
  const scores = { complexity: 1, risk: 9, breadth: 0, uncertainty: 0, latency: 9 };
  assert.equal(decideTier({ scores, config }).tier, "deep");
  assert.equal(decideTier({ scores, config }).guardrail, "risk_force_deep");
  assert.equal(decideTier({ scores, config, override: "fast" }).tier, "fast");
});

test("guardrails: risk>=7 disallows fast; latency fast path applies to low risk only", () => {
  assert.equal(decideTier({ scores: { complexity: 1, risk: 7, breadth: 0, uncertainty: 0, latency: 9 }, config }).tier, "balanced");
  const fastPath = decideTier({ scores: { complexity: 3, risk: 2, breadth: 5, uncertainty: 5, latency: 8 }, config });
  assert.equal(fastPath.tier, "fast");
  assert.equal(fastPath.guardrail, "latency_fast_path");
});

test("thresholds map effort to tiers", () => {
  assert.equal(decideTier({ scores: { complexity: 5, risk: 3, breadth: 0, uncertainty: 1, latency: 0 }, config }).tier, "fast");
  assert.equal(decideTier({ scores: { complexity: 5, risk: 3, breadth: 0, uncertainty: 2, latency: 0 }, config }).tier, "balanced");
  assert.equal(decideTier({ scores: { complexity: 9, risk: 6, breadth: 8, uncertainty: 5, latency: 0 }, config }).tier, "deep");
  assert.equal(effortScore({ complexity: 10, risk: 10, breadth: 10, uncertainty: 10, latency: 0 }), 10);
});

test("heuristic scores match the bundled plugin scorer.mjs on sample prompts", async () => {
  const pluginScorer = await import(require("url").pathToFileURL(path.join(RESOURCES, "plugin", "scripts", "lib", "scorer.mjs")).href);
  const prompts = [
    "quick: what git command shows the last 3 commits?",
    "Rotate the production OAuth secrets and update the payment webhook signature verification across the services",
    "Refactor src/a.ts, src/b.ts and src/c.ts to share the async stream parser; add tests. ```ts\nconst x = 1;\n```",
    "not sure why the deploy is flaky, can you investigate the kubernetes rollout?",
    "[cco:deep] briefly: how do I list files?",
    "",
  ];
  for (const prompt of prompts) {
    const ours = heuristicScores(prompt);
    const theirs = pluginScorer.heuristicScores(prompt);
    assert.deepEqual(ours, theirs, `scores differ for: ${prompt}`);
    const ourDecision = decideTier({ scores: ours, override: parseOverride(prompt), config });
    const theirDecision = pluginScorer.decideTier({ scores: theirs, override: pluginScorer.parseOverride(prompt), config });
    assert.equal(ourDecision.tier, theirDecision.tier, `tier differs for: ${prompt}`);
    assert.equal(ourDecision.effort, theirDecision.effort, `effort differs for: ${prompt}`);
    assert.equal(ourDecision.guardrail, theirDecision.guardrail, `guardrail differs for: ${prompt}`);
  }
});
