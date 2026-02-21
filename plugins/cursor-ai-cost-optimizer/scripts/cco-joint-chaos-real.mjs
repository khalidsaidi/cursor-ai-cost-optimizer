#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCandidates,
  estimateObservedCostUsd,
  loadJointState,
  loadMergedConfig,
  saveJointState,
  selectBaselineCandidate,
  selectJointCandidate,
  updateJointState
} from "./cco-joint-engine.mjs";

function parseArgs(argv) {
  const out = {
    workspace: process.cwd(),
    repeats: 2,
    scenarioLimit: 0,
    keepTmp: false,
    isolated: true
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" && argv[i + 1]) {
      out.workspace = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--repeats" && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        out.repeats = Math.floor(parsed);
      }
      i += 1;
      continue;
    }
    if (arg === "--scenario-limit" && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        out.scenarioLimit = Math.floor(parsed);
      }
      i += 1;
      continue;
    }
    if (arg === "--keep-tmp") {
      out.keepTmp = true;
      continue;
    }
    if (arg === "--no-isolated") {
      out.isolated = false;
      continue;
    }
  }
  return out;
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
    ...options
  });
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0) / 0xffffffff;
}

function tierInstruction(tier) {
  if (tier === "fast") {
    return [
      "Mode: FAST.",
      "Optimize for minimal token usage and short answer.",
      "Do not include extra commentary.",
      "Output only what the task asks."
    ].join(" ");
  }
  if (tier === "deep") {
    return [
      "Mode: DEEP.",
      "Prioritize correctness and safety.",
      "Be explicit about risks and validation where relevant.",
      "Still follow output-format constraints exactly."
    ].join(" ");
  }
  return [
    "Mode: BALANCED.",
    "Balance correctness and brevity.",
    "Follow output-format constraints exactly."
  ].join(" ");
}

function chaosPrefix(index, repeat) {
  const samples = [
    "first time user here, sorry if this sounds messy.",
    "pls dont overthink, but also dont break prod.",
    "i'm in a hurry + a bit stressed, keep it robust.",
    "context might be noisy, extract what matters only.",
    "if ambiguous, choose sensible defaults quickly."
  ];
  return samples[(index + repeat) % samples.length];
}

function buildPrompt(scenario, index, repeat, tier) {
  return [
    chaosPrefix(index, repeat),
    tierInstruction(tier),
    scenario.prompt.trim()
  ].join("\n\n");
}

function parseJsonLines(stdout) {
  const lines = String(stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

function extractResultEvent(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === "result") {
      return events[i];
    }
  }
  return null;
}

function extractJsonObject(text) {
  const raw = String(text || "");
  const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    try {
      return { value: JSON.parse(fenced[1]), source: "fenced" };
    } catch {}
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = raw.slice(first, last + 1);
    try {
      return { value: JSON.parse(candidate), source: "slice" };
    } catch {}
  }
  return { value: null, source: "none" };
}

function nonEmpty(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return String(value || "").trim().length > 0;
}

function evaluateQuality({ scenario, output, isError }) {
  const parsed = extractJsonObject(output);
  const obj = parsed.value;
  const failures = [];

  if (isError) {
    failures.push("is_error=true");
  }
  if (!obj || typeof obj !== "object") {
    failures.push("invalid_json_object");
  } else {
    for (const key of scenario.requiredKeys || []) {
      if (!Object.prototype.hasOwnProperty.call(obj, key) || !nonEmpty(obj[key])) {
        failures.push(`missing_or_empty_key:${key}`);
      }
    }
  }

  const normalizedText = String(output || "").toLowerCase();
  for (const pattern of scenario.requiredPatterns || []) {
    const re = new RegExp(pattern, "i");
    if (!re.test(normalizedText)) {
      failures.push(`missing_pattern:${pattern}`);
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    parsedSource: parsed.source
  };
}

function scenarioMatrix() {
  return [
    {
      id: "quick_command_node_version",
      scores: { complexity: 1, risk: 1, breadth: 1, uncertainty: 1, latency: 9 },
      requiredKeys: ["command", "reason"],
      requiredPatterns: ["node", "version|-v|--version"],
      prompt:
        'Return ONLY valid JSON with keys "command" and "reason". Task: what command checks Node.js version on mac/linux?'
    },
    {
      id: "quick_git_restore_file",
      scores: { complexity: 2, risk: 2, breadth: 2, uncertainty: 2, latency: 8 },
      requiredKeys: ["command", "warning"],
      requiredPatterns: ["git", "restore|checkout"],
      prompt:
        'Return ONLY valid JSON with keys "command" and "warning". Task: undo local edits for one file only.'
    },
    {
      id: "balanced_bug_triage_api_500",
      scores: { complexity: 5, risk: 6, breadth: 4, uncertainty: 4, latency: 3 },
      requiredKeys: ["first_checks", "rollback", "verification"],
      requiredPatterns: ["rollback", "log|trace", "verify|verification"],
      prompt:
        'Return ONLY valid JSON with keys "first_checks" (array of 3), "rollback", and "verification". Task: API endpoint suddenly returns 500 in production.'
    },
    {
      id: "balanced_migration_plan",
      scores: { complexity: 6, risk: 5, breadth: 6, uncertainty: 4, latency: 2 },
      requiredKeys: ["plan", "risks", "fallback"],
      requiredPatterns: ["risk", "fallback|rollback", "step"],
      prompt:
        'Return ONLY valid JSON with keys "plan" (array), "risks" (array), and "fallback". Task: migrate from REST polling to webhooks.'
    },
    {
      id: "balanced_ambiguous_requirements",
      scores: { complexity: 5, risk: 3, breadth: 5, uncertainty: 8, latency: 2 },
      requiredKeys: ["assumptions", "questions", "starter_plan"],
      requiredPatterns: ["assumption", "question", "plan"],
      prompt:
        'Return ONLY valid JSON with keys "assumptions", "questions" (array), and "starter_plan". Task: client asks "make app faster and cleaner".'
    },
    {
      id: "deep_security_token_leak",
      scores: { complexity: 7, risk: 10, breadth: 7, uncertainty: 5, latency: 1 },
      requiredKeys: ["immediate_actions", "containment", "verification", "rollback"],
      requiredPatterns: ["rotate", "revoke|invalidate", "verify|verification", "rollback"],
      prompt:
        'Return ONLY valid JSON with keys "immediate_actions", "containment", "verification", "rollback". Task: possible production API token leak.'
    },
    {
      id: "deep_payments_incident",
      scores: { complexity: 8, risk: 10, breadth: 8, uncertainty: 4, latency: 1 },
      requiredKeys: ["triage", "customer_impact", "rollback", "postmortem_checks"],
      requiredPatterns: ["rollback", "payment", "impact"],
      prompt:
        'Return ONLY valid JSON with keys "triage", "customer_impact", "rollback", "postmortem_checks". Task: payment retries doubled and duplicate charges are reported.'
    },
    {
      id: "deep_data_delete_request",
      scores: { complexity: 6, risk: 9, breadth: 5, uncertainty: 3, latency: 2 },
      requiredKeys: ["safe_procedure", "backup", "dry_run", "rollback"],
      requiredPatterns: ["backup", "dry", "rollback"],
      prompt:
        'Return ONLY valid JSON with keys "safe_procedure", "backup", "dry_run", "rollback". Task: remove old customer rows from production DB safely.'
    },
    {
      id: "deep_compliance_soc2",
      scores: { complexity: 7, risk: 8, breadth: 7, uncertainty: 5, latency: 2 },
      requiredKeys: ["controls", "evidence", "gaps", "next_actions"],
      requiredPatterns: ["control", "evidence", "gap"],
      prompt:
        'Return ONLY valid JSON with keys "controls", "evidence", "gaps", "next_actions". Task: SOC2 control readiness review for access management.'
    },
    {
      id: "override_fast_token",
      scores: { complexity: 8, risk: 9, breadth: 6, uncertainty: 5, latency: 1 },
      requiredKeys: ["decision", "caveat"],
      requiredPatterns: ["fast", "caveat"],
      prompt:
        'Return ONLY valid JSON with keys "decision" and "caveat". Task: [cco:fast] do a deep security review for auth flow.'
    },
    {
      id: "override_deep_token",
      scores: { complexity: 1, risk: 1, breadth: 1, uncertainty: 1, latency: 9 },
      requiredKeys: ["decision", "reason"],
      requiredPatterns: ["deep", "reason"],
      prompt:
        'Return ONLY valid JSON with keys "decision" and "reason". Task: [cco:deep] one-liner request: what is pwd command?'
    },
    {
      id: "first_time_user_chaos_typo",
      scores: { complexity: 4, risk: 3, breadth: 2, uncertainty: 7, latency: 5 },
      requiredKeys: ["steps", "safe_default"],
      requiredPatterns: ["step", "safe"],
      prompt:
        'Return ONLY valid JSON with keys "steps" and "safe_default". Task: "im new plz help i broke branch maybe?? not sure what i did, want safe recovery".'
    }
  ];
}

function createIsolatedWorkspace(tmpRoot) {
  ensureDir(tmpRoot);
  ensureDir(path.join(tmpRoot, "src"));
  fs.writeFileSync(
    path.join(tmpRoot, "README.md"),
    "# tmp-workspace\n\nTemporary first-time-user workspace for CCO chaos benchmark.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(tmpRoot, "src", "index.js"),
    "export function hello() { return 'hello'; }\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(tmpRoot, "package.json"),
    JSON.stringify(
      {
        name: "cco-chaos-workspace",
        private: true,
        version: "0.0.0"
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function ensureWorkspaceConfig({ workspace, defaultsPath }) {
  ensureDir(path.join(workspace, ".cursor"));
  const cfgPath = path.join(workspace, ".cursor", "cco.json");
  if (!fs.existsSync(cfgPath)) {
    const defaults = readJsonSafe(defaultsPath) || {};
    fs.writeFileSync(cfgPath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
  }
}

function runSessionStart({ workspace, sessionStartScript }) {
  const payload = JSON.stringify({
    workspace_roots: [workspace],
    conversation_id: "cco-chaos-benchmark"
  });
  const res = run("node", [sessionStartScript], {
    input: payload
  });
  if (res.status !== 0) {
    throw new Error(`sessionStart hook failed: ${String(res.stderr || "").trim()}`);
  }
}

function runDiscovery({ workspace, discoverScript }) {
  const res = run("node", [discoverScript, "--workspace", workspace], {
    timeout: 240_000
  });
  if (res.status !== 0) {
    throw new Error(`model discovery failed: ${String(res.stderr || "").trim()}`);
  }
}

function runRequest({ workspace, model, tier, prompt, timeoutMs }) {
  const commandArgs = [
    "--model",
    model,
    "--trust",
    "--mode",
    "ask",
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    workspace,
    prompt
  ];
  const res = run("cursor-agent", commandArgs, {
    timeout: timeoutMs
  });

  const events = parseJsonLines(res.stdout || "");
  const resultEvent = extractResultEvent(events);
  const thinkingDeltas = events.filter(
    (event) => event?.type === "thinking" && event?.subtype === "delta"
  );
  const thinkingChars = thinkingDeltas.reduce(
    (sum, event) => sum + String(event?.text || "").length,
    0
  );
  const thinkingCompletedCount = events.filter(
    (event) => event?.type === "thinking" && event?.subtype === "completed"
  ).length;
  const assistantEventCount = events.filter((event) => event?.type === "assistant").length;
  const resultText = String(resultEvent?.result || "");
  const durationApiMs = Number(resultEvent?.duration_api_ms || resultEvent?.duration_ms || 0);
  const durationMs = Number(resultEvent?.duration_ms || 0);
  const isError = Boolean(resultEvent?.is_error) || res.status !== 0 || !resultEvent;

  return {
    status: res.status,
    stderr: String(res.stderr || "").trim().slice(0, 1200),
    rawEventCount: events.length,
    metrics: {
      systemCount: events.filter((event) => event?.type === "system").length,
      userCount: events.filter((event) => event?.type === "user").length,
      thinkingDeltaCount: thinkingDeltas.length,
      thinkingChars,
      thinkingCompletedCount,
      assistantEventCount,
      resultChars: resultText.length,
      durationApiMs,
      durationMs,
      isError
    },
    requestId: resultEvent?.request_id || null,
    output: resultText,
    commandArgs
  };
}

function highRiskSafetyViolation(scores, tier) {
  return Number(scores?.risk || 0) >= 7 && String(tier) === "fast";
}

function chooseOrder(seed) {
  return seed > 0.5 ? ["baseline", "joint"] : ["joint", "baseline"];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(scriptDir, "..");
  const repoRoot = path.resolve(pluginRoot, "../..");
  const defaultsPath = path.join(pluginRoot, "config", "defaults.json");
  const discoverScript = path.join(scriptDir, "cco-discover-models.mjs");
  const sessionStartScript = path.join(scriptDir, "cco-session-start.mjs");

  let benchmarkWorkspace = args.workspace;
  let tempWorkspace = null;
  if (args.isolated) {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cco-chaos-"));
    createIsolatedWorkspace(tempWorkspace);
    benchmarkWorkspace = tempWorkspace;
  } else {
    ensureDir(benchmarkWorkspace);
  }

  ensureWorkspaceConfig({ workspace: benchmarkWorkspace, defaultsPath });
  runSessionStart({ workspace: benchmarkWorkspace, sessionStartScript });
  runDiscovery({ workspace: benchmarkWorkspace, discoverScript });

  const { config } = loadMergedConfig({ workspace: benchmarkWorkspace, defaultsPath });
  const runtimePath = path.join(benchmarkWorkspace, ".cursor", "cco-runtime.json");
  const pricingPath = path.join(benchmarkWorkspace, ".cursor", "cco-pricing.json");
  const runtime = readJsonSafe(runtimePath);
  const pricing = readJsonSafe(pricingPath);
  if (!runtime || !runtime.profiles) {
    throw new Error(`Missing runtime profile mapping at ${runtimePath}`);
  }

  const stateData = loadJointState({ workspace: benchmarkWorkspace });
  let jointState = stateData.state;
  const statePath = stateData.statePath;
  const candidates = buildCandidates(runtime);

  let scenarios = scenarioMatrix();
  if (args.scenarioLimit > 0) {
    scenarios = scenarios.slice(0, args.scenarioLimit);
  }

  const runRecords = [];
  const pairRecords = [];

  for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
    for (let index = 0; index < scenarios.length; index += 1) {
      const scenario = scenarios[index];
      const order = chooseOrder(hashString(`${scenario.id}:${repeat}`));
      const decisions = {};

      const baselineTaskPrompt = buildPrompt(scenario, index, repeat, "balanced");
      const baselineTask = {
        prompt: baselineTaskPrompt,
        promptChars: baselineTaskPrompt.length,
        scores: scenario.scores
      };
      decisions.baseline = selectBaselineCandidate({
        task: baselineTask,
        runtime,
        config
      });
      decisions.joint = selectJointCandidate({
        task: baselineTask,
        runtime,
        state: jointState,
        config,
        pricing,
        candidates
      });

      const policyResults = {};
      for (const policy of order) {
        const selected =
          policy === "baseline"
            ? decisions.baseline
            : decisions.joint.selected;
        const policyPrompt = buildPrompt(scenario, index, repeat, selected.tier);
        const request = runRequest({
          workspace: benchmarkWorkspace,
          model: selected.model,
          tier: selected.tier,
          prompt: policyPrompt,
          timeoutMs: 180_000
        });
        const quality = evaluateQuality({
          scenario,
          output: request.output,
          isError: request.metrics.isError
        });
        const estimatedCostUsd = estimateObservedCostUsd({
          pricing,
          promptChars: policyPrompt.length,
          thinkingChars: request.metrics.thinkingChars,
          assistantChars: request.metrics.resultChars,
          model: selected.model,
          tier: selected.tier,
          config
        });
        const rework = !quality.pass;
        const safetyViolation = highRiskSafetyViolation(scenario.scores, selected.tier);

        const record = {
          policy,
          scenarioId: scenario.id,
          repeat,
          model: selected.model,
          tier: selected.tier,
          decisionReason:
            policy === "baseline" ? "baseline_fuzzy_thresholds" : decisions.joint.reason,
          totalLoss: policy === "joint" ? selected.totalLoss : null,
          components: policy === "joint" ? selected.components : null,
          adaptiveWeights: policy === "joint" ? decisions.joint.adaptiveWeights : null,
          scores: scenario.scores,
          requestId: request.requestId,
          status: request.status,
          stderr: request.stderr,
          outputPreview: request.output.slice(0, 400),
          metrics: request.metrics,
          quality,
          safetyViolation,
          estimatedCostUsd
        };

        runRecords.push(record);
        policyResults[policy] = record;

        if (policy === "joint") {
          jointState = updateJointState({
            state: jointState,
            model: selected.model,
            tier: selected.tier,
            observation: {
              estimatedCostUsd,
              durationApiMs: request.metrics.durationApiMs,
              isError: request.metrics.isError,
              rework,
              thinkingChars: request.metrics.thinkingChars,
              assistantChars: request.metrics.resultChars
            },
            config
          });
        }
      }

      pairRecords.push({
        scenarioId: scenario.id,
        repeat,
        baseline: policyResults.baseline,
        joint: policyResults.joint,
        costDeltaUsd: policyResults.joint.estimatedCostUsd - policyResults.baseline.estimatedCostUsd,
        costReductionPct:
          policyResults.baseline.estimatedCostUsd > 0
            ? (policyResults.baseline.estimatedCostUsd - policyResults.joint.estimatedCostUsd) /
              policyResults.baseline.estimatedCostUsd
            : 0,
        qualityNotWorse:
          Number(policyResults.joint.quality.pass) >= Number(policyResults.baseline.quality.pass),
        latencyDeltaMs:
          Number(policyResults.joint.metrics.durationApiMs || 0) -
          Number(policyResults.baseline.metrics.durationApiMs || 0)
      });
    }
  }

  saveJointState({ statePath, state: jointState });

  const baselineRuns = runRecords.filter((record) => record.policy === "baseline");
  const jointRuns = runRecords.filter((record) => record.policy === "joint");

  const baselineCost = baselineRuns.reduce((sum, record) => sum + record.estimatedCostUsd, 0);
  const jointCost = jointRuns.reduce((sum, record) => sum + record.estimatedCostUsd, 0);
  const costReductionPct = baselineCost > 0 ? (baselineCost - jointCost) / baselineCost : 0;

  const summary = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    benchmarkWorkspace,
    isolatedWorkspace: args.isolated,
    repeats: args.repeats,
    scenarios: scenarios.length,
    runsPerPolicy: baselineRuns.length,
    runtimePath,
    pricingPath,
    statePath,
    aggregate: {
      baseline: {
        estimatedCostUsd: baselineCost,
        qualityPassRate: mean(baselineRuns.map((record) => Number(record.quality.pass))),
        errorRate: mean(baselineRuns.map((record) => Number(record.metrics.isError))),
        safetyViolationRate: mean(baselineRuns.map((record) => Number(record.safetyViolation))),
        avgDurationApiMs: mean(baselineRuns.map((record) => Number(record.metrics.durationApiMs || 0)))
      },
      joint: {
        estimatedCostUsd: jointCost,
        qualityPassRate: mean(jointRuns.map((record) => Number(record.quality.pass))),
        errorRate: mean(jointRuns.map((record) => Number(record.metrics.isError))),
        safetyViolationRate: mean(jointRuns.map((record) => Number(record.safetyViolation))),
        avgDurationApiMs: mean(jointRuns.map((record) => Number(record.metrics.durationApiMs || 0)))
      },
      costReductionPct,
      paired: {
        qualityNotWorseRate: mean(pairRecords.map((record) => Number(record.qualityNotWorse))),
        avgCostReductionPct: mean(pairRecords.map((record) => record.costReductionPct)),
        avgLatencyDeltaMs: mean(pairRecords.map((record) => record.latencyDeltaMs))
      }
    },
    pairRecords,
    runRecords
  };

  const reportDir = path.join(args.workspace, ".ai", "cco");
  ensureDir(reportDir);
  const reportJsonPath = path.join(reportDir, "joint-chaos-real-report.json");
  const reportMdPath = path.join(reportDir, "joint-chaos-real-report.md");
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  let md = "";
  md += "# CCO Joint Scoring Chaos Real Benchmark\n\n";
  md += `- Generated: ${summary.generatedAt}\n`;
  md += `- Isolated workspace: ${String(summary.isolatedWorkspace)}\n`;
  md += `- Benchmark workspace: ${summary.benchmarkWorkspace}\n`;
  md += `- Scenarios: ${summary.scenarios}\n`;
  md += `- Repeats: ${summary.repeats}\n`;
  md += `- Runs per policy: ${summary.runsPerPolicy}\n\n`;

  md += "## Aggregate\n\n";
  md += `- Baseline estimated cost: $${summary.aggregate.baseline.estimatedCostUsd.toFixed(6)}\n`;
  md += `- Joint estimated cost: $${summary.aggregate.joint.estimatedCostUsd.toFixed(6)}\n`;
  md += `- Cost reduction: ${formatPct(summary.aggregate.costReductionPct)}\n`;
  md += `- Baseline quality pass rate: ${formatPct(summary.aggregate.baseline.qualityPassRate)}\n`;
  md += `- Joint quality pass rate: ${formatPct(summary.aggregate.joint.qualityPassRate)}\n`;
  md += `- Baseline avg duration_api_ms: ${summary.aggregate.baseline.avgDurationApiMs.toFixed(1)}\n`;
  md += `- Joint avg duration_api_ms: ${summary.aggregate.joint.avgDurationApiMs.toFixed(1)}\n`;
  md += `- Paired quality-not-worse rate: ${formatPct(summary.aggregate.paired.qualityNotWorseRate)}\n`;
  md += `- Paired avg cost reduction: ${formatPct(summary.aggregate.paired.avgCostReductionPct)}\n`;
  md += `- Paired avg latency delta (joint-baseline): ${summary.aggregate.paired.avgLatencyDeltaMs.toFixed(1)} ms\n\n`;

  md += "## Per Scenario (Paired)\n\n";
  for (const pair of pairRecords) {
    md += `### ${pair.scenarioId} (repeat ${pair.repeat})\n`;
    md += `- Baseline: ${pair.baseline.model} / ${pair.baseline.tier} / $${pair.baseline.estimatedCostUsd.toFixed(6)} / pass=${String(pair.baseline.quality.pass)}\n`;
    md += `- Joint: ${pair.joint.model} / ${pair.joint.tier} / $${pair.joint.estimatedCostUsd.toFixed(6)} / pass=${String(pair.joint.quality.pass)}\n`;
    md += `- Cost reduction: ${formatPct(pair.costReductionPct)}\n`;
    md += `- Quality not worse: ${String(pair.qualityNotWorse)}\n`;
    md += `- Latency delta ms: ${pair.latencyDeltaMs.toFixed(1)}\n\n`;
  }

  md += "## Caveat\n\n";
  md += "- This benchmark uses real Cursor executions and real runtime fields.\n";
  md += "- Cost values are estimated from official Cursor pricing rates + field/token proxies, because per-run billed cost is not exposed in this CLI output.\n";
  fs.writeFileSync(reportMdPath, md, "utf8");

  if (tempWorkspace && !args.keepTmp) {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  }

  console.log(
    JSON.stringify(
      {
        reportJsonPath,
        reportMdPath,
        benchmarkWorkspace: summary.benchmarkWorkspace,
        isolatedWorkspace: summary.isolatedWorkspace,
        costReductionPct: summary.aggregate.costReductionPct,
        baselineCostUsd: summary.aggregate.baseline.estimatedCostUsd,
        jointCostUsd: summary.aggregate.joint.estimatedCostUsd
      },
      null,
      2
    )
  );
}

main();
