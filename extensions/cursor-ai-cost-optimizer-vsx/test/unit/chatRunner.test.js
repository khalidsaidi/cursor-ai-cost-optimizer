const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parseStreamLine, routePrompt, buildCliArgs, priceTurn, stripOverrideTag, usageCostUsd } = require("../../dist/chatRunner.js");
const { loadPricing } = require("../../dist/pricing.js");

const bundled = path.join(__dirname, "..", "..", "resources", "plugin", "config", "pricing.json");
const sample = fs.readFileSync(path.join(__dirname, "..", "fixtures", "cli-stream-sample.jsonl"), "utf8").trim().split("\n");

test("chat runner: real CLI stream lines become init, text, tool and result events with usage", () => {
  const events = sample.map(parseStreamLine).filter(Boolean);
  const init = events.find((e) => e.kind === "init");
  assert.equal(init.model, "Auto");
  assert.match(init.sessionId, /^[0-9a-f-]{36}$/);
  const edit = events.find((e) => e.kind === "tool" && e.tool === "editToolCall" && e.status === "completed");
  assert.ok(edit.diff && edit.diff.startsWith("--- "), "an edit's completion carries the diff Cursor produced");
  assert.equal(edit.ok, true);
  assert.match(edit.label, /^Edit /);
  const relative = sample.map((l) => parseStreamLine(l, "/home/khali/cco-scratch")).find((e) => e && e.kind === "tool" && e.tool === "editToolCall" && e.status === "completed");
  assert.equal(relative.path, "units.mjs", "paths are shown relative to the workspace");
  assert.equal(relative.label, "Edit units.mjs");
  const shell = events.find((e) => e.kind === "tool" && e.tool === "shellToolCall" && e.status === "completed");
  assert.equal(shell.ok, false, "a rejected command is shown as not run");
  assert.match(shell.detail, /not run/);
  const result = events.find((e) => e.kind === "result");
  assert.equal(result.ok, true);
  assert.equal(result.usage.inputTokens, 19613);
  assert.equal(result.usage.cacheReadTokens, 166016);
  assert.equal(parseStreamLine("not json"), null);
});

test("chat runner: a turn is priced at its model's rate and at Auto's fixed rate", () => {
  const pricing = loadPricing(null, bundled);
  const usage = { inputTokens: 18000, outputTokens: 3000, cacheReadTokens: 120000, cacheWriteTokens: 0 };
  const composer = priceTurn(usage, "composer-2.5", pricing);
  assert.ok(Math.abs(composer.usd - (18000 * 0.5 + 3000 * 2.5 + 120000 * 0.2) / 1e6) < 1e-9, String(composer.usd));
  assert.ok(Math.abs(composer.atAutoRateUsd - (18000 * 2 + 3000 * 6 + 120000 * 0.5) / 1e6) < 1e-9, "the same tokens at Auto's billed rate");
  assert.ok(composer.atAutoRateUsd > composer.usd * 2, "Composer's tokens cost less than a third of Auto's");
  assert.equal(usageCostUsd(usage, { input: null, output: null, cacheRead: null, cacheWrite: null }), null);
});

test("chat runner: prompts route by the scorer, tags and the picker force a tier, missing tier models fall back", () => {
  const models = { fast: "composer-2.5", balanced: "claude-sonnet-5-medium", deep: "claude-opus-5-thinking-high" };
  const small = routePrompt({ prompt: "Create units.mjs with three converters and a node:test file", tierModels: models });
  assert.equal(small.tier, "fast");
  assert.equal(small.model, "composer-2.5");
  const risky = routePrompt({ prompt: "Rotate the production OAuth secret and payment webhook signing key", tierModels: models });
  assert.equal(risky.tier, "deep", "risk guardrail");
  const tagged = routePrompt({ prompt: "[cco:deep] rename a variable", tierModels: models });
  assert.equal(tagged.tier, "deep");
  const picked = routePrompt({ prompt: "rename a variable", tierModels: models, forced: "balanced" });
  assert.equal(picked.tier, "balanced");
  const fallback = routePrompt({ prompt: "rename a variable", tierModels: { fast: null, balanced: "claude-sonnet-5-medium", deep: null } });
  assert.equal(fallback.tier, "balanced");
  assert.equal(fallback.fallbackFrom, "fast");
  assert.equal(routePrompt({ prompt: "x", tierModels: { fast: null, balanced: null, deep: null } }), null);
  assert.equal(stripOverrideTag("[cco:deep] rename a variable"), "rename a variable");
});

test("chat runner: CLI arguments", () => {
  const args = buildCliArgs({ model: "composer-2.5", prompt: "do it", resume: "abc", commands: "auto-review" });
  assert.deepEqual(args, ["-p", "--output-format", "stream-json", "--trust", "--model", "composer-2.5", "--auto-review", "--resume", "abc", "do it"]);
  assert.ok(buildCliArgs({ model: "m", prompt: "p", commands: "force" }).includes("--force"));
  assert.ok(!buildCliArgs({ model: "m", prompt: "p", commands: "none" }).includes("--auto-review"));
});
