const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { settingsToPluginConfig, mergeConfigFile } = require("../../dist/settingsCore.js");

test("settings map to the plugin config the hooks read", () => {
  const cfg = settingsToPluginConfig({ tierModels: { fast: " composer-2.5 ", balanced: "", deep: "claude-opus-5-thinking-high" }, enforceRouting: true, alwaysDelegate: true, chatBudgetUsd: 2.5, modelCooldownHours: 12 });
  assert.deepEqual(cfg.modelOverrides, { fast: "composer-2.5", balanced: "", deep: "claude-opus-5-thinking-high" });
  assert.equal(cfg.enforcement.mode, "strict");
  assert.equal(cfg.enforcement.requireDelegation, "always");
  assert.equal(cfg.learning.limitCooldownMinutes, 720);
  assert.equal(cfg.budget.sessionUsd, 2.5);
  const off = settingsToPluginConfig({ tierModels: { fast: "", balanced: "", deep: "" }, enforceRouting: false, alwaysDelegate: false, chatBudgetUsd: -1, modelCooldownHours: 0.01 });
  assert.equal(off.enforcement.mode, "advise");
  assert.equal(off.budget.sessionUsd, 0);
  assert.equal(off.learning.limitCooldownMinutes, 1);
});

test("merging into an existing config keeps unrelated keys and reports tier model changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cco-settings-"));
  const file = path.join(dir, "cco.json");
  fs.writeFileSync(file, JSON.stringify({ enabled: false, pricing: { plan: "pro" }, enforcement: { minSavingsFactor: 2 } }));
  const first = mergeConfigFile(file, settingsToPluginConfig({ tierModels: { fast: "composer-2.5", balanced: "", deep: "" }, enforceRouting: false, alwaysDelegate: false, chatBudgetUsd: 0, modelCooldownHours: 6 }));
  assert.equal(first.changed, true);
  assert.equal(first.tierModelsChanged, true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.enabled, false, "pause state kept");
  assert.equal(written.pricing.plan, "pro", "unrelated keys kept");
  assert.equal(written.enforcement.minSavingsFactor, 2, "nested keys the settings do not own are kept");
  assert.equal(written.enforcement.mode, "advise");
  const again = mergeConfigFile(file, settingsToPluginConfig({ tierModels: { fast: "composer-2.5", balanced: "", deep: "" }, enforceRouting: false, alwaysDelegate: false, chatBudgetUsd: 0, modelCooldownHours: 6 }));
  assert.equal(again.changed, false, "idempotent");
  const budget = mergeConfigFile(file, settingsToPluginConfig({ tierModels: { fast: "composer-2.5", balanced: "", deep: "" }, enforceRouting: false, alwaysDelegate: false, chatBudgetUsd: 3, modelCooldownHours: 6 }));
  assert.equal(budget.changed, true);
  assert.equal(budget.tierModelsChanged, false);
});
