#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = { workspace: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--workspace" && argv[i + 1]) {
      out.workspace = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
    ...options
  });
}

function extractJson(resultText) {
  const fenced = resultText.match(/```json\s*([\s\S]*?)\s*```/i);
  let raw = fenced ? fenced[1] : null;
  if (!raw) {
    const first = resultText.indexOf("{");
    const last = resultText.lastIndexOf("}");
    if (first >= 0 && last > first) {
      raw = resultText.slice(first, last + 1);
    }
  }
  if (!raw) {
    throw new Error("Could not find JSON block in model output.");
  }
  return JSON.parse(raw);
}

function runRouterCase(workspace, testCase) {
  const prompt = [
    "Read plugins/cursor-ai-cost-optimizer/rules/cco-routing.mdc and plugins/cursor-ai-cost-optimizer/agents/cco-router.md.",
    "Use .cursor/cco-runtime.json for preferred model mapping.",
    `User request: "${testCase.user}"`,
    "Deterministic test: use ONLY these fixed scores and do not re-estimate.",
    `Fixed scores: complexity=${testCase.scores.complexity}, risk=${testCase.scores.risk}, breadth=${testCase.scores.breadth}, uncertainty=${testCase.scores.uncertainty}, latency=${testCase.scores.latency}.`,
    "Output ONLY JSON with keys: tier, subagent, preferred_model, effort, guardrail, override."
  ].join(" ");

  const raw = run("cursor-agent", [
    "--model",
    "auto",
    "--trust",
    "--mode",
    "ask",
    "-p",
    "--output-format",
    "json",
    "--workspace",
    workspace,
    prompt
  ]);

  const line = raw.trim().split("\n").filter(Boolean).pop();
  const outer = JSON.parse(line);
  return extractJson(String(outer.result || ""));
}

function main() {
  const { workspace } = parseArgs(process.argv.slice(2));
  const pluginScript = path.join(
    workspace,
    "plugins/cursor-ai-cost-optimizer/scripts/cco-discover-models.mjs"
  );

  run("node", [pluginScript, "--workspace", workspace]);
  const runtimePath = path.join(workspace, ".cursor", "cco-runtime.json");
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));

  const cases = [
    {
      id: "fast_threshold",
      user: "quick one-liner",
      scores: { complexity: 5, risk: 3, breadth: 0, uncertainty: 1, latency: 0 },
      expectedTier: "FAST",
      expectedSubagent: "cco-fast",
      expectedProfile: "fast"
    },
    {
      id: "balanced_threshold",
      user: "normal request",
      scores: { complexity: 5, risk: 3, breadth: 0, uncertainty: 2, latency: 0 },
      expectedTier: "BALANCED",
      expectedSubagent: "cco-balanced",
      expectedProfile: "balanced"
    },
    {
      id: "deep_guardrail_risk",
      user: "prod payments delete",
      scores: { complexity: 2, risk: 8, breadth: 2, uncertainty: 1, latency: 0 },
      expectedTier: "DEEP",
      expectedSubagent: "cco-deep",
      expectedProfile: "deep"
    },
    {
      id: "override_fast",
      user: "[cco:fast] deep security review",
      scores: { complexity: 9, risk: 9, breadth: 7, uncertainty: 3, latency: 0 },
      expectedTier: "FAST",
      expectedSubagent: "cco-fast",
      expectedProfile: "fast"
    },
    {
      id: "override_deep",
      user: "[cco:deep] one-liner pwd",
      scores: { complexity: 1, risk: 0, breadth: 0, uncertainty: 0, latency: 8 },
      expectedTier: "DEEP",
      expectedSubagent: "cco-deep",
      expectedProfile: "deep"
    }
  ];

  const results = [];
  for (const testCase of cases) {
    try {
      const actual = runRouterCase(workspace, testCase);
      const expectedModel = runtime.profiles?.[testCase.expectedProfile]?.model ?? "auto";
      const checks = [
        { key: "tier", ok: String(actual.tier || "").toUpperCase() === testCase.expectedTier },
        { key: "subagent", ok: String(actual.subagent || "") === testCase.expectedSubagent },
        { key: "preferred_model", ok: String(actual.preferred_model || "") === expectedModel }
      ];
      results.push({
        id: testCase.id,
        expected: {
          tier: testCase.expectedTier,
          subagent: testCase.expectedSubagent,
          preferred_model: expectedModel
        },
        actual,
        pass: checks.every((check) => check.ok),
        checks
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        pass: false,
        error: String(error?.message || error)
      });
    }
  }

  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;

  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    runtimePath,
    discoveredProfiles: runtime.profiles,
    total: results.length,
    passed,
    failed,
    results
  };

  const reportDir = path.join(workspace, ".ai", "cco");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "e2e-real-report.json"), JSON.stringify(report, null, 2));

  let markdown = "";
  markdown += "# CCO Real Cursor E2E Report\n\n";
  markdown += `- Generated: ${report.generatedAt}\n`;
  markdown += `- Runtime map: ${runtimePath}\n`;
  markdown += `- Total: ${report.total}\n`;
  markdown += `- Passed: ${report.passed}\n`;
  markdown += `- Failed: ${report.failed}\n\n`;

  for (const result of results) {
    markdown += `## ${result.id} — ${result.pass ? "PASS" : "FAIL"}\n`;
    if (result.error) {
      markdown += `- Error: ${result.error}\n\n`;
      continue;
    }
    markdown += `- Expected: ${JSON.stringify(result.expected)}\n`;
    markdown += `- Actual: ${JSON.stringify(result.actual)}\n`;
    const failedChecks = result.checks.filter((check) => !check.ok).map((check) => check.key);
    markdown += `- Check failures: ${failedChecks.length ? failedChecks.join(", ") : "none"}\n\n`;
  }

  fs.writeFileSync(path.join(reportDir, "e2e-real-report.md"), markdown);
  console.log(
    JSON.stringify(
      {
        reportPath: path.join(reportDir, "e2e-real-report.md"),
        total: report.total,
        passed: report.passed,
        failed: report.failed
      },
      null,
      2
    )
  );
}

main();
