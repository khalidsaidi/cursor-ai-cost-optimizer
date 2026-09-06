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

test("chat runner: streamed word deltas are consolidated once the CLI repeats the whole segment", () => {
  const { consolidateText } = require("../../dist/chatRunner.js");
  let segment = "";
  let shown = "";
  for (const piece of ["the", " quick", " brown"]) {
    const c = consolidateText(segment, piece);
    segment = c.segment;
    shown += c.append;
  }
  assert.equal(shown, "the quick brown");
  const repeat = consolidateText(segment, "the quick brown");
  assert.equal(repeat.append, "", "the consolidated repeat adds nothing");
  assert.equal(repeat.segment, "");
  const next = consolidateText("", "Done.");
  assert.equal(next.append, "Done.");
});

test("chat runner: a conversation keeps its model unless a request needs a stronger tier", () => {
  const { stickyRoute, routePrompt } = require("../../dist/chatRunner.js");
  const models = { fast: "composer-2.5", balanced: "claude-sonnet-5-medium", deep: "claude-opus-5-thinking-high" };
  const first = routePrompt({ prompt: "Refactor src/cart.js so coupon rules live in a table and add tests for it", tierModels: models });
  assert.equal(first.tier, "balanced");
  const small = routePrompt({ prompt: "rename a variable in cart.js", tierModels: models });
  const kept = stickyRoute({ tier: first.tier, model: first.model }, small);
  assert.equal(kept.model, "claude-sonnet-5-medium", "a smaller follow-up stays on the conversation's model");
  assert.equal(kept.kept, true);
  const risky = routePrompt({ prompt: "Rotate the production OAuth secret and payment webhook signing key", tierModels: models });
  const up = stickyRoute({ tier: first.tier, model: first.model }, risky);
  assert.equal(up.tier, "deep", "an escalation moves the conversation up");
  assert.equal(up.kept, false);
  assert.equal(stickyRoute(null, small).kept, false);
});

test("chat runner: the CLI's plain-text failures are recognised", () => {
  const { parseCliErrorLine } = require("../../dist/chatRunner.js");
  const limit = parseCliErrorLine("ActionRequiredError: You've hit your usage limit for Opus You've saved $104 on API model usage this month with Pro. Switch to a different model or set a Spend Limit to continue with Opus.");
  assert.equal(limit.kind, "usage_limit");
  assert.match(limit.message, /^You've hit your usage limit for Opus/);
  assert.equal(parseCliErrorLine('{"type":"result"}'), null, "JSON lines are events, not errors");
  assert.equal(parseCliErrorLine("Not logged in. Run cursor-agent login").kind, "not_logged_in");
  assert.equal(parseCliErrorLine(""), null);
});

test("chat runner: a recorded streamed run with a tool call in the middle renders as two paragraphs, nothing duplicated", () => {
  const { consolidateText, endParagraph } = require("../../dist/chatRunner.js");
  const lines = fs.readFileSync(path.join(__dirname, "..", "fixtures", "cli-stream-partial-sample.jsonl"), "utf8").trim().split("\n");
  let text = "";
  let segment = "";
  for (const line of lines) {
    const ev = parseStreamLine(line);
    if (!ev) continue;
    if (ev.kind === "text") {
      const c = consolidateText(segment, ev.text);
      segment = c.segment;
      if (c.append) text += c.append;
      else text = endParagraph(text);
    } else if (ev.kind === "tool") {
      segment = "";
      text = endParagraph(text);
    }
  }
  const paragraphs = text.trim().split(/\n\n+/);
  assert.equal(paragraphs.length, 2, text);
  assert.match(paragraphs[0], /^I'll add `tiny\.mjs`/);
  assert.match(paragraphs[1], /^Created `tiny\.mjs`/);
  assert.equal((text.match(/I'll add/g) || []).length, 1, "the consolidated repeat is not shown twice");
  assert.equal((text.match(/Created/g) || []).length, 1);
});

test("chat runner: the CLI's login status line is read", () => {
  const { parseCliStatus } = require("../../dist/chatRunner.js");
  assert.deepEqual(parseCliStatus("✓ Logged in as someone@example.com\n"), { loggedIn: true, account: "someone@example.com" });
  assert.deepEqual(parseCliStatus("Not logged in\n"), { loggedIn: false, account: null });
});

test("chat runner: Windows paths from the CLI are shown relative to the workspace whatever the drive letter's case", () => {
  const { relativeTo } = require("../../dist/chatRunner.js");
  assert.equal(relativeTo("c:\\Users\\khali\\cco-win-scratch\\calc.mjs", "C:\\Users\\khali\\cco-win-scratch"), "calc.mjs");
  assert.equal(relativeTo("C:/Users/khali/cco-win-scratch/src/a.ts", "C:\\Users\\khali\\cco-win-scratch"), "src/a.ts");
  assert.equal(relativeTo("/home/k/ws/units.mjs", "/home/k/ws"), "units.mjs");
  assert.equal(relativeTo("/other/place/deep/file.js", "/home/k/ws"), "deep/file.js");
});
