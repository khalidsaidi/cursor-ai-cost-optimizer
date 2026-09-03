import test from "node:test";
import assert from "node:assert/strict";
import { heuristicScores, decideTier, parseOverride, parseScoresLine, applyStateEscalation, formatScoresLine, effortScore } from "../scripts/lib/scorer.mjs";
import { loadDefaults } from "../scripts/lib/config.mjs";

const config = loadDefaults();

test("override tokens are detected anywhere, last one wins", () => {
  assert.equal(parseOverride("please [cco:deep] do this"), "deep");
  assert.equal(parseOverride("[cco:fast] then later [cco:balanced]"), "balanced");
  assert.equal(parseOverride("no token here"), null);
  assert.equal(parseOverride("[CCO:AUTO]"), "auto");
});

test("CCO-SCORES line parses and clamps", () => {
  const scores = parseScoresLine("CCO-SCORES: complexity=4 risk=12 breadth=1 uncertainty=1 latency=6\nthe task");
  assert.deepEqual(scores, { complexity: 4, risk: 10, breadth: 1, uncertainty: 1, latency: 6 });
  assert.equal(parseScoresLine("nothing"), null);
  assert.equal(parseScoresLine("CCO-SCORES: complexity=4"), null, "needs at least three signals");
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

test("learning escalation bumps a failing tier once, never past deep, never over an override", () => {
  const state = { tiers: { fast: { count: 5, emaError: 0.4, emaRework: 0.2 } } };
  assert.equal(applyStateEscalation({ tier: "fast", state, config }).tier, "balanced");
  assert.equal(applyStateEscalation({ tier: "fast", state, config, override: "fast" }).tier, "fast");
  assert.equal(applyStateEscalation({ tier: "fast", state: { tiers: { fast: { count: 1, emaError: 1 } } }, config }).tier, "fast");
  assert.equal(applyStateEscalation({ tier: "deep", state: { tiers: { deep: { count: 9, emaError: 1 } } }, config }).tier, "deep");
});

test("scores line formatting round-trips", () => {
  const line = formatScoresLine({ complexity: 2, risk: 3, breadth: 4, uncertainty: 5, latency: 6 });
  assert.deepEqual(parseScoresLine(line), { complexity: 2, risk: 3, breadth: 4, uncertainty: 5, latency: 6 });
});

test("proseOnly keeps long single-line prose and drops pasted machine output", async () => {
  const { proseOnly, heuristicScores } = await import("../scripts/lib/scorer.mjs");
  const prose = "We need to rotate the production OAuth secret and the payment webhook signing key used in config/auth.js. Implement dual-key support during rotation (old+new) with a rollback path and explain the deployment order. Keep it small.";
  assert.equal(proseOnly(prose), prose);
  assert.ok(heuristicScores(prose).risk >= 7, "a risky one-paragraph request still scores as risky");
  const log = "fix this\n" + JSON.stringify({ error: "ECONNRESET", stack: "at payments.refund (/srv/app/src/payments.js:12:5) production secret token auth".repeat(4), ts: 1725000000000 });
  assert.equal(proseOnly(log), "fix this");
});
