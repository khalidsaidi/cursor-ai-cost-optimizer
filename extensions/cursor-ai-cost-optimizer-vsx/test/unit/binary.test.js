// Exercises the compiled host binary (dist-bin/<host>/cco-hook) exactly as Cursor would call it from
// <ws>/.cursor/hooks.json: payload on stdin, event as argv[2], cwd = workspace. Skipped when the binary
// was not built (`npm run compile:binaries`).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { hostTarget, binaryFileName, installWorkspace, workspacePaths } = require("../../dist/install.js");

const ROOT = path.resolve(__dirname, "../..");
const PLUGIN = path.join(ROOT, "resources", "plugin");
const BINARY = path.join(ROOT, "dist-bin", hostTarget(), binaryFileName());
const available = fs.existsSync(BINARY);
process.env.CCO_CURSOR_AGENT_BIN = require("../fixtures/fake-agent-path.js");

async function setup(configPatch) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-bin-"));
  const r = await installWorkspace(ws, { pluginRoot: PLUGIN, binaryPath: BINARY, extensionVersion: "test", hookRuntime: "binary" });
  const p = workspacePaths(ws);
  if (configPatch) {
    fs.writeFileSync(p.configPath, JSON.stringify(configPatch(fs.existsSync(p.configPath) ? JSON.parse(fs.readFileSync(p.configPath, "utf8")) : {}), null, 2));
  }
  const run = (event, payload) => {
    // exactly like Cursor: cwd = workspace, no CCO_* env, plugin located via .cursor/cco/plugin-path.txt
    const env = { ...process.env };
    delete env.CCO_PLUGIN_ROOT;
    const res = spawnSync(p.binaryPath, [event], { cwd: ws, input: JSON.stringify({ workspace_roots: [ws], ...payload }), encoding: "utf8", timeout: 120_000, env });
    const line = String(res.stdout || "").trim().split("\n").filter(Boolean).pop() || "{}";
    return { status: res.status, stderr: res.stderr, out: JSON.parse(line) };
  };
  return { ws, p, run, install: r };
}

test("compiled binary: shell guard is opt-in (allows by default), preToolUse Read allows, unknown events fail open", { skip: !available && `binary not built: ${BINARY}` }, async () => {
  const t = await setup();
  try {
    assert.equal(t.install.init.status, 0, t.install.init.error);
    const ok = t.run("beforeShellExecution", { command: "ls -la", conversation_id: "c1" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.out.permission, "allow");
    assert.equal(t.run("preToolUse", { tool_name: "Read", tool_input: { path: "README.md" }, conversation_id: "c1" }).out.permission, "allow");
    assert.deepEqual(t.run("somethingElse", {}).out, { continue: true });
  } finally {
    fs.rmSync(t.ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("compiled binary: shell guard denies rm -rf / when enabled in .cursor/cco.json", { skip: !available && `binary not built: ${BINARY}` }, async () => {
  const t = await setup((cfg) => ({ ...cfg, shellGuard: { ...(cfg.shellGuard || {}), enabled: true } }));
  try {
    const deny = t.run("beforeShellExecution", { command: "rm -rf /", conversation_id: "c2" });
    assert.equal(deny.status, 0, deny.stderr);
    assert.equal(deny.out.permission, "deny", JSON.stringify(deny.out));
  } finally {
    fs.rmSync(t.ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("compiled binary: preToolUse Task cco-fast allows with updated_input and logs a decision under .cursor/cco/state", { skip: !available && `binary not built: ${BINARY}` }, async () => {
  const t = await setup();
  try {
    const res = t.run("preToolUse", { conversation_id: "conv-1", tool_name: "Task", tool_input: { description: "List commits", prompt: "Show the last 3 commits", subagent_type: "cco-fast" } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.out.permission, "allow");
    assert.equal(res.out.updated_input?.subagent_type, "cco-fast", JSON.stringify(res.out));
    assert.match(res.out.updated_input.prompt, /^CCO-SCORES: /);
    const decisions = fs.readFileSync(path.join(t.p.stateDir, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(decisions[0].final, "cco-fast");
    assert.equal(decisions[0].model, "composer-2.5", "model read from .cursor/agents/cco-fast.md");
    assert.equal(fs.existsSync(path.join(t.ws, ".ai")), false, "no .ai directory in the workspace");
  } finally {
    fs.rmSync(t.ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("compiled binary: config from .cursor/cco.json overrides plugin defaults (riskForceDeep=2 reroutes)", { skip: !available && `binary not built: ${BINARY}` }, async () => {
  const t = await setup((cfg) => ({ ...cfg, guardrails: { ...(cfg.guardrails || {}), riskForceDeep: 2, riskNoFast: 2 } }));
  try {
    const res = t.run("preToolUse", { conversation_id: "conv-2", tool_name: "Task", tool_input: { description: "x", prompt: "CCO-SCORES: complexity=1 risk=3 breadth=0 uncertainty=0 latency=5\nShow the last 3 commits", subagent_type: "cco-fast" } });
    assert.equal(res.out.updated_input?.subagent_type, "cco-deep", JSON.stringify(res.out));
  } finally {
    fs.rmSync(t.ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("compiled binary: inert when the workspace opts out or has no tier agents", { skip: !available && `binary not built: ${BINARY}` }, async () => {
  const t = await setup((cfg) => ({ ...cfg, enabled: false }));
  try {
    assert.deepEqual(t.run("preToolUse", { conversation_id: "conv-3", tool_name: "Task", tool_input: { prompt: "x", subagent_type: "cco-fast" } }).out, { permission: "allow" });
    fs.writeFileSync(t.p.configPath, "{}");
    fs.rmSync(t.p.agentsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    assert.deepEqual(t.run("preToolUse", { conversation_id: "conv-4", tool_name: "Task", tool_input: { prompt: "x", subagent_type: "cco-fast" } }).out, { permission: "allow" });
  } finally {
    fs.rmSync(t.ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
