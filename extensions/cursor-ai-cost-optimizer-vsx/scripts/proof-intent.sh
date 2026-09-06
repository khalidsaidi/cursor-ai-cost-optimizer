#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROOF_PATH="$ROOT_DIR/test-fixtures/workspace/.ai/cco/test-proof.json"
REPORT_PATH="$ROOT_DIR/test-fixtures/workspace/.ai/cco/proof-intent-report.json"

cd "$ROOT_DIR"

# Run full runtime verification in real Cursor (auth-seeded) and headless integration.
npm run test:cursor
npm test

if [[ ! -f "$PROOF_PATH" ]]; then
  echo "Missing runtime proof file: $PROOF_PATH" >&2
  exit 1
fi

ROOT_DIR="$ROOT_DIR" PROOF_PATH="$PROOF_PATH" REPORT_PATH="$REPORT_PATH" node <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = process.env.ROOT_DIR;
const proofPath = process.env.PROOF_PATH;
const reportPath = process.env.REPORT_PATH;

const extensionTs = path.join(rootDir, 'src/extension.ts');
const scorerTs = path.join(rootDir, 'src/scorer.ts');
const installTs = path.join(rootDir, 'src/install.ts');
const routingRule = path.join(rootDir, 'resources/plugin/rules/cco-routing.mdc');
const fastAgent = path.join(rootDir, 'resources/plugin/agents/fast-tier.md');
const balancedAgent = path.join(rootDir, 'resources/plugin/agents/balanced-tier.md');
const deepAgent = path.join(rootDir, 'resources/plugin/agents/deep-tier.md');
const packageJsonPath = path.join(rootDir, 'package.json');
const gitignorePath = path.join(rootDir, 'test-fixtures/workspace/.gitignore');

const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
const extensionText = fs.readFileSync(extensionTs, 'utf8');
const scorerText = fs.readFileSync(scorerTs, 'utf8');
const installText = fs.readFileSync(installTs, 'utf8');
const ruleText = fs.readFileSync(routingRule, 'utf8');
const fastText = fs.readFileSync(fastAgent, 'utf8');
const balancedText = fs.readFileSync(balancedAgent, 'utf8');
const deepText = fs.readFileSync(deepAgent, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const gitignoreText = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';

const requiredCommands = [
  'cco.installCursorAssets',
  'cco.uninstallCursorAssets',
  'cco.recommendTier',
  'cco.insertOverrideFast',
  'cco.insertOverrideBalanced',
  'cco.insertOverrideDeep',
  'cco.showOutputChannel',
];

const requiredInstallFiles = [
  '.cursor/hooks.json',
  '.cursor/cco.json',
  '.cursor/cco/cco-hook.mjs',
  '.cursor/cco/plugin-path.txt',
  '.cursor/cco/runtime.json',
  '.cursor/agents/fast-tier.md',
  '.cursor/agents/balanced-tier.md',
  '.cursor/agents/deep-tier.md',
  '.cursor/agents/tier-verifier.md',
  '.cursor/rules/cco-routing.mdc',
  '.cursor/skills/cco-init/SKILL.md',
  '.cursor/commands/cco.md',
];

function hasAll(text, snippets) {
  return snippets.every((snippet) => text.includes(snippet));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const allCommandsPresent = requiredCommands.every((cmd) => proof.commandPresence?.[cmd] === true);
const allInstallFilesPresent = requiredInstallFiles.every((p) => proof.installChecks?.files?.[p] === true);
// v0.2.0 rule wording (plugins/cursor-ai-cost-optimizer/rules/cco-routing.mdc)
const routingTierLogicPresent = hasAll(ruleText, [
  '`[cco:fast]`, `[cco:balanced]`, `[cco:deep]` force a tier; `[cco:auto]` restores default routing.',
  'effort = 0.45·complexity + 0.35·risk + 0.15·breadth + 0.10·uncertainty − 0.20·latency',
  'FAST ≤ 3.4 · BALANCED 3.5–6.4 · DEEP ≥ 6.5',
  'risk ≥ 7 never FAST; risk ≥ 9 always DEEP; latency ≥ 7 with risk ≤ 3 and complexity ≤ 3 is FAST',
  'CCO-SCORES: complexity=<n> risk=<n> breadth=<n> uncertainty=<n> latency=<n>',
]);

const extensionTierLogicPresent = hasAll(scorerText, [
  'thresholds: { fastMax: 3.4, balancedMax: 6.4 }',
  'guardrails: { riskNoFast: 7, riskForceDeep: 9 }',
  'if (s.latency >= 7 && s.risk <= 3 && s.complexity <= 3) {',
  'guardrail = s.risk >= riskForceDeep ? "risk_force_deep" : "risk_no_fast";',
]);

const overrideInsertLogicPresent = hasAll(extensionText, [
  'insertOverrideFast',
  'insertOverrideBalanced',
  'insertOverrideDeep',
  'insertAtCursor("[cco:fast]")',
  'insertAtCursor("[cco:balanced]")',
  'insertAtCursor("[cco:deep]")',
]);

const agentEscalationPresent = fastText.includes('CCO-ESCALATE: balanced')
  && balancedText.includes('CCO-ESCALATE: deep')
  && deepText.includes('include the rollback path in the result')
  && ruleText.includes('If a subagent returns `CCO-ESCALATE: <tier>` or `CCO-VERIFY: fail`, delegate once to the next tier up');

// v0.2.0 hygiene: nothing outside .cursor/, no .gitignore edits, no .ai/ writes
const hygieneInCode = !installText.includes('appendGitignoreLine') && !/\.ai[\/"]/.test(installText.replace(/\/\*[\s\S]*?\*\//g, ''));

const hooksWired = proof.installChecks?.hooks?.foreignEntryPreserved === true
  && proof.installChecks?.hooks?.ccoEntriesValid === true
  && proof.uninstallChecks?.foreignHookPreserved === true
  && proof.uninstallChecks?.ccoHooksRemoved === true;

const hygieneInWorkspace = !gitignoreText.includes('.ai/*') && Array.isArray(proof.installChecks?.topLevelEntries) && !proof.installChecks.topLevelEntries.includes('.ai');

const commandsInManifest = Array.isArray(pkg.activationEvents) && pkg.activationEvents.includes('onStartupFinished')
  && requiredCommands.every((cmd) => Array.isArray(pkg.contributes?.commands) && pkg.contributes.commands.some((c) => c.command === cmd));

const insertProofMatched = proof.insertChecks?.matched === true;

const claims = [
  {
    id: 'shared_routing_policy_install',
    claim: 'Installs the project-local plugin layout (.cursor/hooks.json, agents, cco.json, cco/) plus rule/skills/commands.',
    pass: allInstallFilesPresent,
    evidence: [
      'test-proof.installChecks.files all required entries true',
      'src/install.ts installCursorAssets flow',
      'resources/cursor/rules/cco-routing.mdc routing policy (v0.2.0)',
    ],
  },
  {
    id: 'cheap_by_default_escalation',
    claim: 'Cheap-by-default FAST with escalation to BALANCED/DEEP by risk/complexity.',
    pass: routingTierLogicPresent && extensionTierLogicPresent,
    evidence: [
      'resources/cursor/rules/cco-routing.mdc:20-22 effort formula, thresholds, guardrails',
      'src/scorer.ts decideTier guardrails/thresholds (port of scripts/lib/scorer.mjs)',
    ],
  },
  {
    id: 'explicit_override_tokens',
    claim: 'Explicit override tokens ([cco:fast], [cco:balanced], [cco:deep]).',
    pass: overrideInsertLogicPresent && insertProofMatched,
    evidence: [
      'src/extension.ts:157-170 token generation + insert commands',
      'test-proof.insertChecks matched true',
      'resources/cursor/rules/cco-routing.mdc:10-11 override tokens',
    ],
  },
  {
    id: 'operational_guardrails',
    claim: 'Operational guardrails bias high-risk tasks to DEEP.',
    pass: extensionTierLogicPresent && ruleText.includes('risk ≥ 7 never FAST; risk ≥ 9 always DEEP') && agentEscalationPresent,
    evidence: [
      'src/scorer.ts risk/latency guardrails',
      'resources/cursor/rules/cco-routing.mdc:22 guardrail text; :33-34 cascade (CCO-ESCALATE / CCO-VERIFY)',
      'resources/cursor/agents/cco-{fast,balanced}.md escalation contract; deep-tier.md rollback path',
    ],
  },
  {
    id: 'ai_artifact_hygiene',
    claim: 'Writes nothing outside <workspace>/.cursor/ (no .ai/, no .gitignore edits).',
    pass: hygieneInCode && hygieneInWorkspace,
    evidence: [
      'src/install.ts has no gitignore/.ai writes',
      'test-proof.installChecks.topLevelEntries unchanged by install',
    ],
  },
  {
    id: 'hooks_enforce_routing',
    claim: 'Installs workspace hooks (.cursor/hooks.json) that run the CCO scripts, merging with and preserving other tools\' entries; uninstall removes only ours.',
    pass: hooksWired,
    evidence: [
      'test-proof.installChecks.hooks foreignEntryPreserved/ccoEntriesRelative true',
      'test-proof.uninstallChecks foreignHookPreserved/ccoHooksRemoved true',
      'src/install.ts mergeHooks/stripCcoHooks',
    ],
  },
  {
    id: 'command_palette_adoption',
    claim: 'Provides practical command palette commands for adoption.',
    pass: allCommandsPresent && commandsInManifest,
    evidence: [
      'package.json:16-29 activation + contributes commands',
      'test-proof.commandPresence all five commands true',
    ],
  },
];

const allPass = claims.every((c) => c.pass);

const report = {
  generatedAt: new Date().toISOString(),
  extensionId: proof.extensionId,
  overallPass: allPass,
  claims,
  runtimeProofPath: proofPath,
  fileHashes: {
    'src/extension.ts': sha256(extensionTs),
    'src/install.ts': sha256(installTs),
    'src/scorer.ts': sha256(scorerTs),
    'resources/plugin/rules/cco-routing.mdc': sha256(routingRule),
    'resources/plugin/agents/fast-tier.md': sha256(fastAgent),
    'resources/plugin/agents/balanced-tier.md': sha256(balancedAgent),
    'resources/plugin/agents/deep-tier.md': sha256(deepAgent),
    'package.json': sha256(packageJsonPath),
  },
  runtimeProof: proof,
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (!allPass) {
  console.error('Proof report generated but one or more claims failed.');
  process.exit(1);
}

console.log(`Proof report generated: ${reportPath}`);
NODE

echo "Proof report generated successfully: $REPORT_PATH"
