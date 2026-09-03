import test from "node:test";
import assert from "node:assert/strict";
import { parsePricingMarkdown, resolveModelPrice, usageCostUsd, loadPricing, blendedRatePerMillion } from "../scripts/lib/pricing.mjs";
import { parseModelsOutput, rankCandidates, classifyModel } from "../scripts/lib/models.mjs";
import { loadDefaults } from "../scripts/lib/config.mjs";

const SAMPLE_MD = `
## Cursor Models

| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| ----- | -------- | ----- | ----------- | ---------- | ------ | ----- |
| [Composer 2.5](https://cursor.com/blog/composer-2-5) | Cursor | $0.5 | - | $0.2 | $2.5 | - |
| [Composer 2.5 (Fast)](https://cursor.com/blog/composer-2-5) | Cursor | $3 | - | $0.5 | $15 | - |
| Grok 4.6 | Cursor | $2 | - | $0.5 | $6 | Jointly trained |

## Other Models

| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| ----- | -------- | ----- | ----------- | ---------- | ------ | ----- |
| [Claude Opus 5](https://www.anthropic.com/claude/opus) | Anthropic | $5 | $6.25 | $0.5 | $25 | Requires Max Mode on legacy plans |
| [Claude 4.5 Sonnet](https://www.anthropic.com/claude/sonnet) | Anthropic | $3 | $3.75 | $0.3 | $15 | Hidden |
| [GPT-5.6 Sol](https://openai.com) | OpenAI | $4 | $5 | $0.4 | $20 | - |
| [GPT-5.3 Codex](https://openai.com) | OpenAI | $1.75 | - | $0.175 | $14 | - |
| [Gemini 3.7 Flash](https://google.com) | Google | $0.75 | - | $0.075 | $3.5 | Hidden by default |
`;

test("parses markdown price tables across sections and strips links", () => {
  const rows = parsePricingMarkdown(SAMPLE_MD);
  assert.equal(rows.length, 8);
  const composer = rows.find((r) => r.name === "Composer 2.5");
  assert.deepEqual([composer.input, composer.cacheWrite, composer.cacheRead, composer.output], [0.5, null, 0.2, 2.5]);
  const opus = rows.find((r) => r.name === "Claude Opus 5");
  assert.equal(opus.cacheWrite, 6.25);
  assert.equal(opus.provider, "Anthropic");
});

test("resolves CLI model ids to price rows, including effort/thinking/fast suffixes", () => {
  const pricing = { models: parsePricingMarkdown(SAMPLE_MD) };
  assert.equal(resolveModelPrice("claude-opus-5-thinking-high", pricing).matchedRow, "Claude Opus 5");
  assert.equal(resolveModelPrice("composer-2.5-fast", pricing).matchedRow, "Composer 2.5 (Fast)");
  assert.equal(resolveModelPrice("composer-2.5", pricing).matchedRow, "Composer 2.5");
  assert.equal(resolveModelPrice("cursor-grok-4.6-low", pricing).matchedRow, "Grok 4.6");
  assert.equal(resolveModelPrice("sonnet-4.5", pricing).matchedRow, "Claude 4.5 Sonnet");
  assert.equal(resolveModelPrice("gpt-5.6-sol-xhigh", pricing).matchedRow, "GPT-5.6 Sol");
  assert.equal(resolveModelPrice("gemini-3.7-flash-high", pricing).matchedRow, "Gemini 3.7 Flash");
  const codexFast = resolveModelPrice("gpt-5.3-codex-low-fast", pricing);
  assert.equal(codexFast.matchedRow, "GPT-5.3 Codex");
  assert.equal(codexFast.input, 3.5, "fast variants without a dedicated row are 2x");
  assert.equal(resolveModelPrice("auto", pricing).confidence, "estimate");
  assert.equal(resolveModelPrice("totally-unknown-model", pricing).confidence, "unknown");
  assert.equal(resolveModelPrice("claude-opus-5-thinking-high[context=1m]", pricing).matchedRow, "Claude Opus 5");
});

test("cost from usage object uses cache prices and optional token rate", () => {
  const pricing = { models: parsePricingMarkdown(SAMPLE_MD) };
  const price = resolveModelPrice("claude-opus-5-thinking-high", pricing);
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 };
  assert.equal(Number(usageCostUsd(usage, price).toFixed(4)), 5 + 2.5 + 1);
  const withRate = usageCostUsd(usage, price, { tokenRatePerMillion: 0.25 });
  assert.equal(Number(withRate.toFixed(4)), 8.5 + 0.25 * 3.1);
  const cursorPrice = resolveModelPrice("composer-2.5", pricing);
  assert.equal(usageCostUsd(usage, cursorPrice, { tokenRatePerMillion: 0.25 }), usageCostUsd(usage, cursorPrice), "first-party models are exempt");
  assert.equal(usageCostUsd(usage, resolveModelPrice("unknown", pricing)), null);
});

test("bundled pricing snapshot loads and covers current flagship models", () => {
  const pricing = loadPricing(null);
  assert.ok(pricing.models.length >= 30);
  for (const id of ["composer-2.5", "cursor-grok-4.6-high", "claude-sonnet-5-thinking-high", "claude-opus-5-thinking-high", "gpt-5.6-sol-high", "gpt-5.6-luna-high", "gemini-3.8-flash-high"]) {
    assert.equal(resolveModelPrice(id, pricing).confidence, "id", `expected a price for ${id}`);
  }
});

test("parses `cursor-agent models` output and ranks candidates by preference then price", () => {
  const listing = parseModelsOutput(`Available models\n\nauto - Auto (current, default)\ncomposer-2.5 - Composer 2.5\ncomposer-2.5-fast - Composer 2.5 Fast\ngemini-3.7-flash-high - Gemini 3.7 Flash\ngpt-5.6-luna-high - GPT-5.6 Luna 1M High\nclaude-opus-5-thinking-high - Claude Opus 5 1M Thinking\ncursor-grok-4.6-high - Cursor Grok 4.6\ngemini-3-pro-image-preview - Gemini 3 Pro Image Preview\n`);
  assert.equal(listing.current, "auto");
  assert.equal(listing.defaultModel, "auto");
  assert.equal(listing.models.find((m) => m.id === "auto").label, "Auto");
  const config = loadDefaults();
  const pricing = loadPricing(null);
  const fast = rankCandidates({ tier: "fast", models: listing.models, pricing, config });
  assert.equal(fast[0].id, "composer-2.5");
  assert.ok(!fast.some((c) => c.id === "auto"), "auto is excluded");
  assert.ok(!fast.some((c) => /preview/.test(c.id)), "preview models are excluded");
  const deep = rankCandidates({ tier: "deep", models: listing.models, pricing, config });
  assert.equal(deep[0].id, "claude-opus-5-thinking-high");
  assert.ok(blendedRatePerMillion(fast[0].price) < blendedRatePerMillion(deep[0].price));
});

test("classifies model ids", () => {
  assert.deepEqual(classifyModel("claude-opus-5-thinking-high-fast"), { id: "claude-opus-5-thinking-high-fast", effort: "high", fast: true, thinking: true, family: "claude-opus-5" });
  assert.equal(classifyModel("composer-2.5").effort, null);
});
