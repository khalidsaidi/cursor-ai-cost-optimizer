#!/usr/bin/env node
/**
 * Real cost benchmark. Costs real usage.
 *
 * For each scenario, runs the task twice in fresh isolated workspaces:
 *   baseline : one model for everything (default: the account's deep-tier model, i.e. what a
 *              "just use the strongest model" user pays), no plugin
 *   cco      : the plugin's routed tier model for the task, with the tier's budget instructions
 * and prices the *actual* token usage reported by the CLI with Cursor's published per-model rates.
 * Quality is checked with deterministic assertions (files, tests, required output patterns).
 *
 *   node scripts/cco-benchmark.mjs [--workspace <report root>] [--repeats 1] [--baseline-model <id>]
 *                                  [--include-overhead] [--keep-tmp] [--only id1,id2]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, writeJson, nowIso, TIERS, workspacePaths, PLUGIN_ROOT, isMain } from "./lib/common.mjs";
import { runAgent } from "./lib/cli-run.mjs";
import { discover } from "./cco-discover-models.mjs";
import { snapshotCliModel, restoreCliModel } from "./lib/models.mjs";
import { PLUGIN_ROOT as REPO_PLUGIN_ROOT } from "./lib/common.mjs";
import { installHooks } from "./cco-install-hooks.mjs";
import { loadConfig } from "./lib/config.mjs";
import { BUNDLED_PRICING_PATH } from "./lib/pricing.mjs";
import { loadPricing, resolveModelPrice, usageCostUsd } from "./lib/pricing.mjs";
import { heuristicScores, decideTier } from "./lib/scorer.mjs";

const TIER_INSTRUCTIONS = {
  fast: "Mode: FAST. Minimal tool use, terse output, no extra commentary.",
  balanced: "Mode: BALANCED. Brief plan, implement, verify cheaply.",
  deep: "Mode: DEEP. Correctness first; verify with the narrowest real check; include the rollback path."
};

function scenarioMatrix() {
  return [
    {
      id: "quick_git_question",
      mode: "ask",
      prompt: "Which git command shows the last 3 commits one per line? Reply with the command and one sentence.",
      check: ({ text }) => /git log/.test(text) && /--oneline|-3/.test(text)
    },
    {
      id: "small_util_with_test",
      prompt: 'Create utils/slugify.js exporting slugify(str) (lowercase, spaces to hyphens, strip other non-alphanumerics) and utils/slugify.test.mjs (node:test) asserting slugify("Hello World!") === "hello-world". Run node --test utils/ and make sure it passes.',
      check: ({ ws }) => fileExists(ws, "utils/slugify.js") && nodeTestPasses(ws, "utils/slugify.test.mjs")
    },
    {
      id: "bug_fix_off_by_one",
      setup: (ws) => {
        fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
        fs.writeFileSync(path.join(ws, "lib", "range.js"), "export function range(n) {\n  const out = [];\n  for (let i = 1; i <= n; i += 1) out.push(i);\n  return out;\n}\n");
        fs.writeFileSync(path.join(ws, "lib", "range.test.mjs"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { range } from "./range.js";\ntest("range(3) is 0..2", () => assert.deepEqual(range(3), [0, 1, 2]));\n');
      },
      prompt: "lib/range.test.mjs fails. Fix the bug in lib/range.js so the test passes; do not change the test. Run node --test lib/ to confirm.",
      check: ({ ws }) => nodeTestPasses(ws, "lib/range.test.mjs")
    },
    {
      id: "refactor_with_regression_test",
      setup: (ws) => {
        fs.mkdirSync(path.join(ws, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(ws, "src", "cart.js"),
          "export function total(items, coupon) {\n  let t = 0;\n  for (const it of items) t += it.price * it.qty;\n  if (coupon === 'TEN') t = t - t * 0.1;\n  if (coupon === 'FIVE') t = t - 5;\n  if (t < 0) t = 0;\n  return Math.round(t * 100) / 100;\n}\n"
        );
      },
      prompt: "Refactor src/cart.js so coupon rules live in a small COUPONS table (code → function) instead of if-chains, keeping the exported total(items, coupon) behavior identical. Add src/cart.test.mjs (node:test) covering no coupon, TEN, FIVE and the never-below-zero rule, and run node --test src/.",
      check: ({ ws }) => nodeTestPasses(ws, "src/cart.test.mjs") && /COUPONS/.test(readSafe(ws, "src/cart.js"))
    },
    {
      id: "risky_auth_rotation_plan",
      setup: (ws) => {
        fs.mkdirSync(path.join(ws, "config"), { recursive: true });
        fs.writeFileSync(path.join(ws, "config", "auth.js"), 'module.exports = { oauthSecret: process.env.OAUTH_SECRET, webhookKey: process.env.WEBHOOK_KEY };\n');
      },
      prompt: "We must rotate the production OAuth secret and payment webhook signing key in config/auth.js. Implement dual-key support (current + previous) so both validate during rotation, keep the existing exports working, add a small node:test in config/auth.test.mjs, run it, and write ROTATION.md with the deployment order and rollback steps.",
      check: ({ ws }) => nodeTestPasses(ws, "config/auth.test.mjs") && /rollback/i.test(readSafe(ws, "ROTATION.md"))
    },
    {
      id: "medium_feature_three_files",
      setup: (ws) => {
        fs.mkdirSync(path.join(ws, "src"), { recursive: true });
        fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "bench", type: "module", private: true }, null, 2));
        fs.writeFileSync(path.join(ws, "src", "store.js"), "const items = new Map();\nexport function put(id, value) { items.set(id, value); }\nexport function get(id) { return items.get(id); }\nexport function all() { return [...items.values()]; }\nexport function reset() { items.clear(); }\n");
      },
      prompt: "Build a tiny in-memory todo module on top of src/store.js: src/todos.js exporting addTodo(title), completeTodo(id), listTodos({ status }) where status is 'open'|'done'|'all', with ids as incrementing integers and validation errors for empty titles / unknown ids; src/todos-cli.js that prints listTodos('all') as JSON when run with node; and src/todos.test.mjs (node:test) covering add, complete, filtering, and both validation errors. Run node --test src/ and make sure everything passes.",
      check: ({ ws }) => nodeTestPasses(ws, "src/todos.test.mjs") && fileExists(ws, "src/todos-cli.js") && /completeTodo/.test(readSafe(ws, "src/todos.js"))
    },
    {
      id: "real_repo_bug_fix",
      setup: (ws) => seedRealRepo(ws, { breakScorer: true }),
      prompt: "node --test test/ fails (scorer tests). Find the root cause in scripts/lib and fix it without changing any test; then run node --test test/ and confirm everything passes.",
      check: ({ ws }) => nodeTestPasses(ws, "test/scorer.test.mjs") && nodeTestPasses(ws, "test/pricing.test.mjs")
    },
    {
      id: "real_repo_feature",
      setup: (ws) => seedRealRepo(ws, { breakScorer: false }),
      prompt: "In scripts/cco-report.mjs add a --csv flag that prints one line per tier as tier,model,inputPerMillion,outputPerMillion,delegations (header first) instead of markdown, reusing buildReport(). Add a node:test in test/report.test.mjs that builds a temp workspace with a couple of decisions in .ai/cco/decisions.jsonl and asserts the CSV output. Run node --test test/ and make sure everything passes.",
      check: ({ ws }) => nodeTestPasses(ws, "test/report.test.mjs") && /--csv|csv/.test(readSafe(ws, "scripts/cco-report.mjs"))
    },
    {
      id: "explain_code_question",
      mode: "ask",
      setup: (ws) => {
        fs.mkdirSync(path.join(ws, "src"), { recursive: true });
        fs.writeFileSync(path.join(ws, "src", "debounce.js"), "export function debounce(fn, ms) {\n  let t;\n  return (...a) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...a), ms);\n  };\n}\n");
      },
      prompt: "In two or three sentences, what does src/debounce.js do and when would a leading-edge variant be preferable?",
      check: ({ text }) => /debounce|delay|timer|timeout/i.test(text) && /leading/i.test(text)
    }
  ];
}

/** Copy this plugin's real scripts/tests/config into the workspace as a realistic codebase fixture. */
function seedRealRepo(ws, { breakScorer }) {
  const src = PLUGIN_ROOT;
  for (const dir of ["scripts", "test", "config", "agents"]) {
    fs.cpSync(path.join(src, dir), path.join(ws, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "cco-fixture", type: "module", private: true, scripts: { test: "node --test" } }, null, 2));
  if (breakScorer) {
    const scorerPath = path.join(ws, "scripts", "lib", "scorer.mjs");
    const text = fs.readFileSync(scorerPath, "utf8");
    // Subtle bug: override detection keeps the first token instead of the last, and clamps risk at 8.
    const broken = text
      .replace("if (index > bestIndex) {", "if (index !== -1 && bestIndex === -1) {")
      .replace("out[key] = clamp(asNumber(scores[key], 0), 0, 10);", "out[key] = clamp(asNumber(scores[key], 0), 0, key === \"risk\" ? 8 : 10);");
    fs.writeFileSync(scorerPath, broken);
  }
}

function readSafe(ws, rel) {
  try {
    return fs.readFileSync(path.join(ws, rel), "utf8");
  } catch {
    return "";
  }
}

function fileExists(ws, rel) {
  return fs.existsSync(path.join(ws, rel));
}

function nodeTestPasses(ws, rel) {
  if (!fileExists(ws, rel)) {
    return false;
  }
  const res = spawnSync(process.execPath, ["--test", rel], { cwd: ws, encoding: "utf8", timeout: 60_000 });
  return res.status === 0;
}

function freshWorkspace(root, name) {
  const ws = fs.mkdtempSync(path.join(root, `cco-bench-${name}-`));
  fs.writeFileSync(path.join(ws, "README.md"), "# benchmark fixture\n");
  spawnSync("git", ["init", "-q"], { cwd: ws });
  return ws;
}

function priceFor(model, pricing, config) {
  return resolveModelPrice(model, pricing, { overrides: config?.pricing?.overrides });
}

function costOf(run, model, pricing, config) {
  const price = priceFor(model, pricing, config);
  const tokenRate = config?.pricing?.plan && /teams|enterprise/i.test(config.pricing.plan) ? config.pricing.teamsTokenRatePerMillion : 0;
  const usd = usageCostUsd(run.usage, price, { tokenRatePerMillion: tokenRate });
  // Warm-session estimate: in an ongoing IDE chat the system context is already cached, so the
  // one-time cache write of a fresh session becomes a cache read. Applies to the chat model only.
  let warmUsd = usd;
  if (usd !== null && run.usage && Number.isFinite(price.cacheWrite) && Number.isFinite(price.cacheRead)) {
    const cw = Number(run.usage.cacheWriteTokens || 0);
    warmUsd = usd - (cw * price.cacheWrite) / 1_000_000 + (cw * price.cacheRead) / 1_000_000;
  }
  return { usd, warmUsd, price };
}

function mainInner() {
  const args = parseArgs(process.argv.slice(2), { workspace: process.cwd(), repeats: 1, "baseline-model": null, "include-overhead": false, "keep-tmp": false, only: null, timeout: 600 });
  const reportRoot = path.resolve(String(args.workspace));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cco-bench-"));
  const only = args.only ? String(args.only).split(",").map((s) => s.trim()) : null;
  const repeats = Math.max(1, Number(args.repeats) || 1);

  const seed = freshWorkspace(tmpRoot, "seed");
  fs.mkdirSync(path.dirname(workspacePaths(seed).pricingPath), { recursive: true });
  fs.copyFileSync(BUNDLED_PRICING_PATH, workspacePaths(seed).pricingPath);
  const config = loadConfig(seed);
  installHooks({ workspace: seed, pluginRoot: process.env.CCO_PLUGIN_ROOT });
  const runtime = discover({ workspace: seed, probe: true, writeAgents: true, config });
  const profiles = Object.fromEntries(TIERS.map((tier) => [tier, runtime.profiles[tier].model]));
  if (TIERS.some((tier) => profiles[tier] === "inherit")) {
    console.error("Discovery could not map every tier to a runnable model; benchmark needs three real models.");
    process.exit(2);
  }
  const pricing = loadPricing(workspacePaths(seed).pricingPath);
  const baselineModel = args["baseline-model"] ? String(args["baseline-model"]) : profiles.deep;
  console.log(JSON.stringify({ profiles, baselineModel, repeats }, null, 2));

  const scenarios = scenarioMatrix().filter((s) => !only || only.includes(s.id));
  const runs = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const scenario of scenarios) {
      const scores = heuristicScores(scenario.prompt);
      const decision = decideTier({ scores, config });
      const tier = decision.tier;
      const policies = [
        { policy: "baseline", model: baselineModel, prompt: scenario.prompt, plugin: false },
        { policy: "cco", model: profiles[tier], prompt: `${TIER_INSTRUCTIONS[tier]}\n\n${scenario.prompt}`, plugin: false }
      ];
      if (args["include-overhead"]) {
        policies.push({ policy: "cco_via_parent", model: baselineModel, prompt: scenario.prompt, plugin: true });
      }
      const order = (repeat + scenarios.indexOf(scenario)) % 2 === 0 ? policies : [...policies].reverse();
      for (const p of order) {
        const ws = freshWorkspace(tmpRoot, `${scenario.id}-${p.policy}-${repeat}`);
        if (scenario.setup) {
          scenario.setup(ws);
        }
        if (p.plugin) {
          fs.cpSync(path.join(seed, ".cursor"), path.join(ws, ".cursor"), { recursive: true });
          fs.rmSync(workspacePaths(ws).stateDir, { recursive: true, force: true });
        }
        const run = runAgent({ workspace: ws, model: p.model, prompt: p.prompt, mode: scenario.mode || "agent", plugin: p.plugin, timeoutMs: Number(args.timeout) * 1000 });
        let pass = false;
        try {
          pass = Boolean(scenario.check({ ws, text: run.resultText })) && !run.isError;
        } catch {
          pass = false;
        }
        const { usd, warmUsd, price } = costOf(run, p.model, pricing, config);
        const delegated = run.tasks.filter((t) => /^(fast|balanced|deep)-tier$|^(cco-(fast|balanced|deep))$/.test(String(t.subagent || "")));
        const record = {
          repeat,
          scenario: scenario.id,
          policy: p.policy,
          tier,
          scores,
          model: p.model,
          priceRow: price.matchedRow,
          usage: run.usage,
          costUsd: usd,
          warmCostUsd: warmUsd,
          costKnown: usd !== null,
          durationApiMs: run.durationApiMs,
          wallMs: run.wallMs,
          toolCalls: run.tools.length,
          delegations: delegated.map((d) => `${d.subagent}:${d.model}`),
          pass,
          isError: run.isError,
          note: p.plugin ? "parent usage only; subagent tokens are billed separately and not visible in CLI output" : ""
        };
        runs.push(record);
        console.log(`${scenario.id} ${p.policy.padEnd(14)} ${p.model.padEnd(30)} tier=${tier} pass=${pass} cost=$${usd === null ? "?" : usd.toFixed(5)} api=${run.durationApiMs}ms tools=${run.tools.length}`);
      }
    }
  }

  const byPolicy = {};
  for (const r of runs) {
    const b = (byPolicy[r.policy] ||= { runs: 0, costUsd: 0, warmCostUsd: 0, costKnownRuns: 0, pass: 0, errors: 0, durationApiMs: 0, toolCalls: 0 });
    b.runs += 1;
    if (r.costKnown) {
      b.costUsd += r.costUsd;
      b.warmCostUsd += r.warmCostUsd ?? r.costUsd;
      b.costKnownRuns += 1;
    }
    b.pass += r.pass ? 1 : 0;
    b.errors += r.isError ? 1 : 0;
    b.durationApiMs += r.durationApiMs;
    b.toolCalls += r.toolCalls;
  }
  for (const b of Object.values(byPolicy)) {
    b.passRate = b.runs ? b.pass / b.runs : 0;
    b.avgDurationApiMs = b.runs ? b.durationApiMs / b.runs : 0;
    b.avgToolCalls = b.runs ? b.toolCalls / b.runs : 0;
  }
  const pairs = [];
  for (const r of runs.filter((x) => x.policy === "baseline")) {
    const c = runs.find((x) => x.policy === "cco" && x.scenario === r.scenario && x.repeat === r.repeat);
    const v = runs.find((x) => x.policy === "cco_via_parent" && x.scenario === r.scenario && x.repeat === r.repeat);
    if (c) {
      // True CCO cost in an IDE chat on the baseline model: the chat model's routing turn(s) (warm)
      // plus the subagent's full session (a subagent is always a fresh session). When the routed tier
      // is the same model as the chat model, CCO keeps the work in the chat (no subagent): cost = baseline.
      const sameModel = c.model === r.model;
      const delegated = v ? v.delegations.length > 0 : true;
      const trueCco = sameModel || !delegated ? (v ? v.warmCostUsd : r.warmCostUsd) : (v ? v.warmCostUsd : 0) + c.costUsd;
      pairs.push({
        scenario: r.scenario,
        repeat: r.repeat,
        tier: c.tier,
        baseline: r,
        cco: c,
        viaParent: v || null,
        sameModel,
        baselineWarmUsd: r.warmCostUsd,
        trueCcoUsd: trueCco,
        savingsPct: r.costUsd ? (r.costUsd - c.costUsd) / r.costUsd : null,
        warmSavingsPct: r.warmCostUsd ? (r.warmCostUsd - trueCco) / r.warmCostUsd : null,
        qualityNotWorse: Number(c.pass) >= Number(r.pass)
      });
    }
  }
  const base = byPolicy.baseline || { costUsd: 0 };
  const cco = byPolicy.cco || { costUsd: 0 };
  const summary = {
    generatedAt: nowIso(),
    cliVersion: runtime.cli.version,
    profiles,
    baselineModel,
    repeats,
    scenarios: scenarios.map((s) => s.id),
    pricingSource: pricing.source?.url || pricing.loadedFrom,
    method: "Real cursor-agent runs in fresh temp workspaces; cost = CLI-reported token usage × Cursor published per-model rates (cache read/write priced separately). Quality = deterministic checks (files exist, node --test passes, required phrases). 'Warm' = the chat model's one-time system-context cache write re-priced as a cache read, i.e. an ongoing IDE chat; subagent sessions are always priced in full. Auto mode is not used as a baseline because its routed model is not observable.",
    aggregate: {
      byPolicy,
      costReductionPct: base.costUsd > 0 ? (base.costUsd - cco.costUsd) / base.costUsd : null,
      warmBaselineUsd: pairs.reduce((sum, p) => sum + (p.baselineWarmUsd || 0), 0),
      trueCcoUsd: pairs.reduce((sum, p) => sum + (p.trueCcoUsd || 0), 0),
      warmCostReductionPct: (() => {
        const b = pairs.reduce((sum, p) => sum + (p.baselineWarmUsd || 0), 0);
        const t = pairs.reduce((sum, p) => sum + (p.trueCcoUsd || 0), 0);
        return b > 0 ? (b - t) / b : null;
      })(),
      pairedQualityNotWorseRate: pairs.length ? pairs.filter((p) => p.qualityNotWorse).length / pairs.length : null,
      pairedMedianSavingsPct: median(pairs.map((p) => p.savingsPct).filter((v) => v !== null))
    },
    pairs,
    runs
  };
  const reportDir = path.join(reportRoot, ".ai", "cco");
  writeJson(path.join(reportDir, "benchmark-report.json"), summary);
  fs.writeFileSync(path.join(reportDir, "benchmark-report.md"), renderMarkdown(summary));
  if (!args["keep-tmp"]) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ reportPath: path.join(reportDir, "benchmark-report.md"), costReductionPct: summary.aggregate.costReductionPct, baselinePass: base.passRate, ccoPass: cco.passRate }, null, 2));
}

function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(v) {
  return v === null || v === undefined || Number.isNaN(v) ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

export function renderMarkdown(summary) {
  const a = summary.aggregate;
  const b = a.byPolicy.baseline || {};
  const c = a.byPolicy.cco || {};
  let md = "# CCO real cost benchmark\n\n";
  md += `- Generated: ${summary.generatedAt}\n- CLI: ${summary.cliVersion}\n- Baseline model (everything): ${summary.baselineModel}\n- CCO tier models: fast=${summary.profiles.fast}, balanced=${summary.profiles.balanced}, deep=${summary.profiles.deep}\n- Scenarios: ${summary.scenarios.length} × repeats ${summary.repeats}\n- Pricing: ${summary.pricingSource}\n\n`;
  md += "## Aggregate\n\n| Metric | Baseline | CCO |\n|---|---:|---:|\n";
  md += `| Total cost (USD) | $${(b.costUsd || 0).toFixed(4)} | $${(c.costUsd || 0).toFixed(4)} |\n`;
  md += `| Quality pass rate | ${pct(b.passRate)} | ${pct(c.passRate)} |\n`;
  md += `| Avg API time (ms) | ${Math.round(b.avgDurationApiMs || 0)} | ${Math.round(c.avgDurationApiMs || 0)} |\n`;
  md += `| Avg tool calls | ${(b.avgToolCalls || 0).toFixed(1)} | ${(c.avgToolCalls || 0).toFixed(1)} |\n\n`;
  md += `- Cost reduction (model-vs-model, fresh sessions): **${pct(a.costReductionPct)}**\n- Paired quality-not-worse: ${pct(a.pairedQualityNotWorseRate)}\n- Paired median savings: ${pct(a.pairedMedianSavingsPct)}\n`;
  if (a.trueCcoUsd !== undefined) {
    md += `- **In an IDE chat on ${summary.baselineModel} (warm context): $${a.warmBaselineUsd.toFixed(4)} → $${a.trueCcoUsd.toFixed(4)} = ${pct(a.warmCostReductionPct)} lower** (chat model routing turns + full subagent sessions; same-model tiers stay in the chat)\n`;
  }
  md += "\n";
  if (a.byPolicy.cco_via_parent) {
    const o = a.byPolicy.cco_via_parent;
    md += `Routing overhead (parent on ${summary.baselineModel} delegating through the plugin, parent tokens only): $${o.costUsd.toFixed(4)} across ${o.runs} runs, pass ${pct(o.passRate)}.\n\n`;
  }
  md += "## Per scenario\n\n| Scenario | Tier | Tier model | Baseline $ (fresh) | Tier model $ (fresh) | Baseline $ (warm) | CCO in chat $ | Warm savings | Quality |\n|---|---|---|---:|---:|---:|---:|---:|:---:|\n";
  for (const p of summary.pairs) {
    md += `| ${p.scenario} (r${p.repeat}) | ${p.tier} | ${p.sameModel ? "same as chat" : p.cco.model} | $${(p.baseline.costUsd ?? 0).toFixed(4)} | $${(p.cco.costUsd ?? 0).toFixed(4)} | $${(p.baselineWarmUsd ?? 0).toFixed(4)} | $${(p.trueCcoUsd ?? 0).toFixed(4)} | ${pct(p.warmSavingsPct)} | ${p.baseline.pass && p.cco.pass ? "✓/✓" : `${p.baseline.pass ? "✓" : "✗"}/${p.cco.pass ? "✓" : "✗"}`} |\n`;
  }
  md += `\n## Method\n\n${summary.method}\n`;
  return md;
}

function main() {
  // Isolate: temp account home and a temp copy of the plugin, so neither the repo nor the account is touched.
  const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cco-iso-"));
  const pluginCopy = path.join(isoRoot, "plugin");
  fs.cpSync(REPO_PLUGIN_ROOT, pluginCopy, { recursive: true, filter: (src) => !/node_modules|\.git($|\/)/.test(src) });
  process.env.CCO_PLUGIN_ROOT = pluginCopy;
  // Every --model call persists into ~/.cursor/cli-config.json; put the user's model back afterwards.
  const snapshot = snapshotCliModel();
  const restore = () => {
    const r = restoreCliModel(snapshot);
    if (!r.restored) {
      console.error(`warning: could not restore CLI model (${r.reason})`);
    }
  };
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  try {
    mainInner();
  } finally {
    restore();
  }
}

if (isMain(import.meta.url)) {
  main();
}
