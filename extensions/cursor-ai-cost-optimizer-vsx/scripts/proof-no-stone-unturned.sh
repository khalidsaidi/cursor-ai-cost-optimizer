#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
OUT_DIR="$ROOT_DIR/test-fixtures/workspace/.ai/cco"
EXT_LOG_FILE="${TMPDIR:-/tmp}/cursor-ext-tests.log"
EXT_PROOF_REPORT="$OUT_DIR/proof-intent-report.json"
EXT_RUNTIME_PROOF="$OUT_DIR/test-proof.json"
IDE_AUTH_REPORT="$OUT_DIR/ide-auth-proof.json"
PLUGIN_E2E_REPORT="$REPO_ROOT/.ai/cco/e2e-real-report.json"
NATURAL_REPORT="$REPO_ROOT/.ai/cco/natural-routing-report.json"
FINAL_REPORT="$OUT_DIR/no-stone-unturned-proof.json"
STATUS_FILE="${TMPDIR:-/tmp}/cco-cursor-agent-status.txt"

mkdir -p "$OUT_DIR" "$(dirname "$PLUGIN_E2E_REPORT")"

strip_ansi() {
  sed -r 's/\x1B\[[0-9;]*[A-Za-z]//g'
}

echo "==> Checking cursor-agent authentication..."
cursor-agent status > "$STATUS_FILE.raw" 2>&1 || true
cat "$STATUS_FILE.raw" | strip_ansi > "$STATUS_FILE"

echo "==> Running real routing E2E against plugin policy..."
node "$REPO_ROOT/plugins/cursor-ai-cost-optimizer/scripts/cco-e2e-real.mjs" --workspace "$REPO_ROOT"

echo "==> Running natural user-prompt routing checks (asserted via the hooks' decisions.jsonl, not model output)..."
# A temp workspace gets the SAME install the extension performs (node hook mode, so cursor-agent's own
# node is enough), then headless cursor-agent sessions run natural prompts; the CCO hooks in
# .cursor/hooks.json log every delegation to .ai/cco/decisions.jsonl, which is what we assert on.
ROOT_DIR="$ROOT_DIR" REPO_ROOT="$REPO_ROOT" NATURAL_REPORT="$NATURAL_REPORT" node <<'NODE'
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.env.ROOT_DIR;
const repoRoot = process.env.REPO_ROOT;
const outPath = process.env.NATURAL_REPORT;
const { installWorkspace } = require(path.join(root, 'dist', 'install.js'));
const jsonl = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-natural-'));
function makeWorkspace(name) {
  const ws = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(ws, 'config'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'config', 'auth.js'), 'module.exports = { oauthSecret: process.env.OAUTH_SECRET, webhookKey: "abc" };\n');
  fs.writeFileSync(path.join(ws, 'README.md'), '# natural routing fixture\n');
  installWorkspace(ws, { pluginRoot: path.join(root, 'resources', 'plugin'), binaryPath: null, extensionVersion: 'no-stone', hookRuntime: 'node' });
  return ws;
}

const cases = [
  { id: 'natural_quick', user: 'quick one-liner: what command checks node version on mac and linux?', mode: 'ask', expect: { maxTier: 'fast', allowNoDelegation: true } },
  { id: 'natural_risky', user: 'we may have leaked a production API token used in config/auth.js; implement key rotation with a rollback path and explain the deployment order', mode: 'agent', expect: { minTier: 'deep', allowNoDelegation: false } },
  { id: 'natural_override_balanced', user: '[cco:balanced] add a one-line comment at the top of README.md saying this is a fixture', mode: 'agent', expect: { exactTier: 'balanced', override: 'balanced', allowNoDelegation: false } }
];
const order = ['fast', 'balanced', 'deep'];
const tierOf = (agent) => String(agent || '').replace(/^cco-/, '');

const results = [];
for (const c of cases) {
  const ws = makeWorkspace(c.id);
  const args = ['--trust', '-f', '-p', '--output-format', 'json', '--workspace', ws, '--model', 'auto'];
  if (c.mode !== 'agent') args.push('--mode', c.mode);
  args.push(c.user);
  const started = Date.now();
  const res = spawnSync('cursor-agent', args, { cwd: ws, encoding: 'utf8', timeout: 480000, maxBuffer: 16 * 1024 * 1024 });
  const decisions = jsonl(path.join(ws, '.cursor', 'cco', 'state', 'decisions.jsonl'));
  const hooks = jsonl(path.join(ws, '.cursor', 'cco', 'state', 'hooks.jsonl'));
  const delegations = decisions.filter((d) => /^cco-/.test(String(d.final || '')));
  const failures = [];
  if (!hooks.length) failures.push('no hook records: workspace hooks did not run under cursor-agent');
  if (!delegations.length && !c.expect.allowNoDelegation) failures.push('expected a cco-* delegation decision, none logged');
  for (const d of delegations) {
    const t = tierOf(d.final);
    if (c.expect.maxTier && order.indexOf(t) > order.indexOf(c.expect.maxTier)) failures.push(`delegation ${d.final} above max tier ${c.expect.maxTier}`);
    if (c.expect.minTier && order.indexOf(t) < order.indexOf(c.expect.minTier)) failures.push(`delegation ${d.final} below min tier ${c.expect.minTier}`);
    if (c.expect.exactTier && t !== c.expect.exactTier) failures.push(`delegation ${d.final} != ${c.expect.exactTier}`);
    if (c.expect.override && d.override !== c.expect.override) failures.push(`override ${d.override} != ${c.expect.override}`);
  }
  if (res.status !== 0) failures.push(`cursor-agent exit ${res.status}: ${String(res.stderr || '').slice(0, 200)}`);
  results.push({ id: c.id, user: c.user, mode: c.mode, expect: c.expect, pass: failures.length === 0, failures, decisions: delegations.map((d) => ({ requested: d.requested, final: d.final, model: d.model, override: d.override, reason: d.reason })), hookEvents: [...new Set(hooks.map((h) => h.event))], wallMs: Date.now() - started, workspace: ws });
  console.log(`${failures.length ? 'FAIL' : 'PASS'} ${c.id} ${failures.join('; ')}`);
}
const report = { generatedAt: new Date().toISOString(), method: 'decisions.jsonl written by the installed CCO hooks during headless cursor-agent runs', total: results.length, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results };
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outPath, total: report.total, passed: report.passed, failed: report.failed }, null, 2));
NODE

echo "==> Running extension functional proof suite..."
(
  cd "$ROOT_DIR"
  CCO_POST_RUN_HOLD_SECONDS="${CCO_POST_RUN_HOLD_SECONDS:-1}" bash ./scripts/proof-intent.sh
)

echo "==> Running dedicated IDE authentication proof..."
(
  cd "$ROOT_DIR"
  npm run compile >/dev/null
  bash ./scripts/proof-ide-auth.sh
)

echo "==> Building no-stone-unturned combined proof report..."
ROOT_DIR="$ROOT_DIR" REPO_ROOT="$REPO_ROOT" EXT_LOG_FILE="$EXT_LOG_FILE" EXT_PROOF_REPORT="$EXT_PROOF_REPORT" EXT_RUNTIME_PROOF="$EXT_RUNTIME_PROOF" IDE_AUTH_REPORT="$IDE_AUTH_REPORT" PLUGIN_E2E_REPORT="$PLUGIN_E2E_REPORT" NATURAL_REPORT="$NATURAL_REPORT" FINAL_REPORT="$FINAL_REPORT" STATUS_FILE="$STATUS_FILE" node <<'NODE'
const fs = require('node:fs');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function parseStatus(statusText) {
  const text = String(statusText || '');
  const line = text.split('\n').find((x) => x.includes('Logged in as')) || '';
  const match = line.match(/Logged in as\s+(.+)\s*$/);
  const email = match ? match[1].trim() : '';
  return {
    loggedIn: Boolean(match),
    account: email
  };
}

function countUnauth(logText) {
  const matches = String(logText || '').match(/unauthenticated|No authorization header found/gi);
  return matches ? matches.length : 0;
}

const statusText = exists(process.env.STATUS_FILE) ? fs.readFileSync(process.env.STATUS_FILE, 'utf8') : '';
const auth = parseStatus(statusText);

const extProof = readJson(process.env.EXT_PROOF_REPORT);
const extRuntime = readJson(process.env.EXT_RUNTIME_PROOF);
const ideAuth = readJson(process.env.IDE_AUTH_REPORT);
const pluginE2E = readJson(process.env.PLUGIN_E2E_REPORT);
const natural = readJson(process.env.NATURAL_REPORT);
const extLog = exists(process.env.EXT_LOG_FILE) ? fs.readFileSync(process.env.EXT_LOG_FILE, 'utf8') : '';
const ideUnauthCount = countUnauth(extLog);

const extensionPass = Boolean(extProof.overallPass);
const ideAuthPass = Boolean(ideAuth.pass);
const pluginPass = Number(pluginE2E.passed || 0) === Number(pluginE2E.total || 0);
const naturalPass = Number(natural.passed || 0) === Number(natural.total || 0);

const overallPass = auth.loggedIn && extensionPass && ideAuthPass && pluginPass && naturalPass;

const report = {
  generatedAt: new Date().toISOString(),
  overallPass,
  proofIntent: {
    extensionFunctionalPass: extensionPass,
    ideFullyAuthenticatedPass: ideAuthPass,
    pluginRealRoutingPass: pluginPass,
    naturalPromptRoutingPass: naturalPass,
    cursorAgentAuthenticated: auth.loggedIn
  },
  authEvidence: {
    cursorAgentStatusPath: process.env.STATUS_FILE,
    cursorAgentAccount: auth.account || null,
    ideAuthProofPath: process.env.IDE_AUTH_REPORT,
    ideAuthProof: ideAuth,
    ideExtensionTestLogPath: process.env.EXT_LOG_FILE,
    ideUnauthenticatedEventCount: ideUnauthCount
  },
  artifacts: {
    extensionProofPath: process.env.EXT_PROOF_REPORT,
    extensionRuntimeProofPath: process.env.EXT_RUNTIME_PROOF,
    pluginE2EReportPath: process.env.PLUGIN_E2E_REPORT,
    naturalRoutingReportPath: process.env.NATURAL_REPORT
  },
  summary: {
    extensionClaimsPassed: extProof.claims?.filter((c) => c.pass).length || 0,
    extensionClaimsTotal: extProof.claims?.length || 0,
    pluginCasesPassed: pluginE2E.passed,
    pluginCasesTotal: pluginE2E.total,
    naturalCasesPassed: natural.passed,
    naturalCasesTotal: natural.total
  },
  caveat:
    ideUnauthCount > 0 && ideAuthPass
      ? 'Cursor extension-test mode can emit unauthenticated AI connect events even when functional extension tests pass; IDE authentication is validated separately by proof-ide-auth.sh in normal Cursor mode.'
      : null
};

fs.mkdirSync(require('node:path').dirname(process.env.FINAL_REPORT), { recursive: true });
fs.writeFileSync(process.env.FINAL_REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Combined proof report: ${process.env.FINAL_REPORT}`);
console.log(JSON.stringify(report, null, 2));

if (!overallPass) {
  process.exit(1);
}
NODE

rm -f "$STATUS_FILE.raw"
echo "✅ No-stone-unturned proof complete: $FINAL_REPORT"
