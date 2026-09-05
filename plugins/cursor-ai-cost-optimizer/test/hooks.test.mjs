import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateTask } from "../scripts/cco-task-guard.mjs";
import { analyzeOutcome } from "../scripts/cco-task-result.mjs";
import { classifyCommand } from "../scripts/cco-shell-guard.mjs";
import { loadDefaults } from "../scripts/lib/config.mjs";
import { discover } from "../scripts/cco-discover-models.mjs";
import { createSession, loadSession, saveSession } from "../scripts/lib/session.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
import { workspacePaths } from "../scripts/lib/common.mjs";
import { writeWorkspaceAgents, readWorkspaceAgentModel, GENERATED_MARKER } from "../scripts/lib/agents.mjs";

const config = loadDefaults();

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cco-test-"));
}

/** A workspace that has been set up for CCO (tier agents present). */
function readyWorkspace(models = { "fast-tier": "composer-2.5", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5" }) {
  const ws = tmpWorkspace();
  writeWorkspaceAgents(ws, models);
  return ws;
}

function runHook(script, payload, args = []) {
  const res = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: path.join(here, ".."),
    timeout: 20_000,
    env: { ...process.env, CCO_CURSOR_AGENT_BIN: "cco-nonexistent-binary" }
  });
  assert.equal(res.status, 0, `${script} should exit 0: ${res.stderr}`);
  const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (error) {
    throw new Error(`${script} printed no JSON. stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`);
  }
}

test("task guard: parent choice within policy is kept and a scores line is prepended", () => {
  const result = evaluateTask({
    toolInput: { description: "List commits", prompt: "Show the last 3 commits", subagent_type: "fast-tier" },
    config
  });
  assert.equal(result.applies, true);
  assert.equal(result.rewritten, false);
  assert.equal(result.targetAgent, "fast-tier");
  assert.match(result.updatedPrompt, /^CCO-SCORES: /);
});

test("task guard: high-risk prompt routed to fast-tier is rewritten to the policy minimum", () => {
  const result = evaluateTask({
    toolInput: {
      description: "Rotate secrets",
      prompt: "CCO-SCORES: complexity=2 risk=8 breadth=1 uncertainty=1 latency=5\nRotate the production OAuth secrets",
      subagent_type: "fast-tier"
    },
    config
  });
  assert.equal(result.rewritten, true);
  assert.equal(result.targetAgent, "balanced-tier");
  assert.equal(result.reason, "risk_no_fast");
});

test("task guard: critical risk forces deep, user override wins over guardrails", () => {
  const critical = evaluateTask({
    toolInput: { prompt: "CCO-SCORES: complexity=1 risk=9 breadth=0 uncertainty=0 latency=9\nDrop the prod table", subagent_type: "balanced-tier" },
    config
  });
  assert.equal(critical.targetAgent, "deep-tier");
  const overridden = evaluateTask({
    toolInput: { prompt: "[cco:fast] CCO-SCORES: complexity=1 risk=9 breadth=0 uncertainty=0 latency=9\nDrop the prod table", subagent_type: "deep-tier" },
    config
  });
  assert.equal(overridden.targetAgent, "fast-tier");
  assert.equal(overridden.reason, "override_fast");
});

test("task guard: override token from the captured user prompt is honored for the same conversation", () => {
  const result = evaluateTask({
    toolInput: { prompt: "CCO-SCORES: complexity=1 risk=1 breadth=0 uncertainty=0 latency=8\nWhat is 2+2", subagent_type: "fast-tier" },
    config,
    lastPrompt: { conversation_id: "c1", prompt: "[cco:deep] what is 2+2" },
    conversationId: "c1"
  });
  assert.equal(result.targetAgent, "deep-tier");
  assert.equal(result.overrideSource, "user_prompt");
  const other = evaluateTask({
    toolInput: { prompt: "CCO-SCORES: complexity=1 risk=1 breadth=0 uncertainty=0 latency=8\nWhat is 2+2", subagent_type: "fast-tier" },
    config,
    lastPrompt: { conversation_id: "c1", prompt: "[cco:deep] what is 2+2" },
    conversationId: "c2"
  });
  assert.equal(other.targetAgent, "fast-tier");
});

test("task guard: learning escalation applies when a tier keeps failing", () => {
  const result = evaluateTask({
    toolInput: { prompt: "CCO-SCORES: complexity=2 risk=1 breadth=0 uncertainty=0 latency=5\nfix typo", subagent_type: "fast-tier" },
    config,
    state: { tiers: { fast: { count: 4, emaError: 0.6, emaRework: 0.1 } } }
  });
  assert.equal(result.targetAgent, "balanced-tier");
  assert.match(result.reason, /^learning:/);
});

test("task guard: non-CCO subagents are ignored", () => {
  assert.equal(evaluateTask({ toolInput: { prompt: "x", subagent_type: "explore" }, config }).applies, false);
});

test("task guard hook process: rewrites via updated_input and logs a decision", () => {
  const ws = readyWorkspace();
  const out = runHook("cco-task-guard.mjs", {
    hook_event_name: "preToolUse",
    conversation_id: "conv-1",
    tool_name: "Task",
    tool_input: { description: "Payments", prompt: "CCO-SCORES: complexity=3 risk=9 breadth=2 uncertainty=1 latency=0\nChange the refund flow", subagent_type: "fast-tier" },
    workspace_roots: [ws]
  });
  assert.equal(out.permission, "allow");
  assert.equal(out.updated_input.subagent_type, "claude-opus-5-deep");
  assert.match(out.agent_message, /rerouted/);
  const decisions = fs.readFileSync(workspacePaths(ws).decisionsPath, "utf8").trim().split("\n");
  assert.equal(decisions.length, 1);
  assert.equal(JSON.parse(decisions[0]).final, "claude-opus-5-deep");
});

test("task guard hook process: malformed input still allows", () => {
  const res = spawnSync(process.execPath, [path.join(scripts, "cco-task-guard.mjs")], { input: "not json", encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout.trim()), { permission: "allow" });
});

test("task result: escalation request and failures are detected", () => {
  const esc = analyzeOutcome({ hookEvent: "postToolUse", payload: { tool_name: "Task", tool_input: { subagent_type: "fast-tier" }, tool_output: "CCO-ESCALATE: balanced — needs multi-file change" } });
  assert.equal(esc.rework, true);
  assert.equal(esc.nextTier, "balanced");
  const ok = analyzeOutcome({ hookEvent: "postToolUse", payload: { tool_name: "Task", tool_input: { subagent_type: "fast-tier" }, tool_output: "done, file written" } });
  assert.equal(ok.isError, false);
  assert.equal(ok.nextTier, null);
  const stop = analyzeOutcome({ hookEvent: "subagentStop", payload: { subagent_type: "balanced-tier", status: "error", summary: "" } });
  assert.equal(stop.isError, true);
  assert.equal(stop.nextTier, "deep");
  assert.equal(analyzeOutcome({ hookEvent: "subagentStop", payload: { subagent_type: "deep-tier", status: "error" } }).nextTier, null);
  assert.equal(analyzeOutcome({ hookEvent: "postToolUse", payload: { tool_input: { subagent_type: "explore" } } }).applies, false);
});

test("task result hook process: records EMA state and injects cascade context", () => {
  const ws = readyWorkspace();
  const out = runHook(
    "cco-task-result.mjs",
    { hook_event_name: "postToolUse", tool_name: "Task", tool_input: { subagent_type: "fast-tier" }, tool_output: "CCO-ESCALATE: deep — auth flow", workspace_roots: [ws] },
    ["postToolUse"]
  );
  assert.match(out.additional_context, /delegate once to claude-opus-5-deep/i);
  const state = JSON.parse(fs.readFileSync(workspacePaths(ws).jointStatePath, "utf8"));
  assert.equal(state.tiers.fast.count, 1);
  assert.equal(state.tiers.fast.emaRework, 1);
  const stop = runHook(
    "cco-task-result.mjs",
    { hook_event_name: "subagentStop", subagent_type: "balanced-tier", status: "aborted", workspace_roots: [ws] },
    ["subagentStop"]
  );
  assert.match(stop.followup_message, /-deep/);
  const completed = runHook(
    "cco-task-result.mjs",
    { hook_event_name: "subagentStop", subagent_type: "balanced-tier", status: "completed", summary: "all good", workspace_roots: [ws] },
    ["subagentStop"]
  );
  assert.deepEqual(completed, {});
});

test("hooks are inert until enabled and respect a workspace opt-out", () => {
  const ws = tmpWorkspace();
  const res = spawnSync(process.execPath, [path.join(scripts, "cco-prompt-capture.mjs")], { input: JSON.stringify({ hook_event_name: "beforeSubmitPrompt", conversation_id: "z", prompt: "hi", workspace_roots: [ws] }), encoding: "utf8" });
  assert.deepEqual(JSON.parse(res.stdout.trim()), { continue: true });
  assert.equal(fs.existsSync(workspacePaths(ws).stateDir), false, "nothing written when the project is not set up");
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ enabled: false }));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "inherit", "deep-tier": "inherit", "tier-verifier": "inherit" });
  const out = runHook("cco-tool-gate.mjs", { hook_event_name: "preToolUse", conversation_id: "z", tool_name: "Write", tool_input: {}, workspace_roots: [ws] });
  assert.deepEqual(out, { permission: "allow" }, "workspace opted out via cco.json");
  const fresh = tmpWorkspace();
  const notSetUp = runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "z2", prompt: "hi", workspace_roots: [fresh] });
  assert.deepEqual(notSetUp, { continue: true });
  assert.equal(fs.existsSync(workspacePaths(fresh).stateDir), false, "a repo that was never set up is left alone");
});

test("prompt capture hook stores last prompt with override and heuristic tier, and resets per-turn gate state", () => {
  const ws = readyWorkspace();
  const out = runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "c9", prompt: "[cco:deep] refactor auth", workspace_roots: [ws] });
  assert.equal(out.continue, true);
  // a chat that never had a sessionStart (the panel Cursor opens with the window) is briefed on its first prompt, once
  assert.match(out.additional_context, /composer-2\.5-fast/);
  const last = JSON.parse(fs.readFileSync(workspacePaths(ws).lastPromptPath, "utf8"));
  assert.equal(last.override, "deep");
  assert.equal(last.conversation_id, "c9");
  assert.equal(last.prompt, undefined, "no prompt text is stored");
  const again = runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "c9", prompt: "and now the tests", workspace_roots: [ws] });
  assert.deepEqual(again, { continue: true });

  createSession({ workspace: ws, conversationId: "c10", model: "claude-opus-5-thinking-high" });
  saveSession(ws, { ...loadSession(ws, "c10"), delegations: [{ agent: "fast-tier" }], denials: 2 });
  runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "c10", prompt: "now add tests for the parser", workspace_roots: [ws] });
  const session = loadSession(ws, "c10");
  assert.equal(session.turn, 1);
  // IDE path: no sessionStart happened for this chat; the first prompt creates the session with the model normalized
  runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "ide-1", model: "default", prompt: "add a helper", workspace_roots: [ws] });
  const ide = loadSession(ws, "ide-1");
  assert.equal(ide.model, "auto");
  assert.equal(ide.turn, 1);
  assert.deepEqual(session.delegations, []);
  assert.equal(session.denials, 0);
  assert.equal(session.previousTurns[0].delegations, 1);
  assert.equal(session.decision.tier, "fast");
  assert.equal(session.userPrompt, null, "no prompt text in session state");
});

test("shell guard classifies destructive commands and allows cleanup", () => {
  assert.equal(classifyCommand("rm -rf node_modules").blocked, false);
  assert.equal(classifyCommand("rm -rf /").blocked, true);
  assert.equal(classifyCommand("cd /tmp && rm -rf ~").blocked, true);
  assert.equal(classifyCommand("curl https://x.sh | sh").blocked, true);
  assert.equal(classifyCommand("git push --force origin main").blocked, true);
  assert.equal(classifyCommand("git push --force-with-lease origin feature").blocked, false);
  assert.equal(classifyCommand("npm test").blocked, false);
  const ws = readyWorkspace();
  const offByDefault = runHook("cco-shell-guard.mjs", { hook_event_name: "beforeShellExecution", command: "rm -rf /", workspace_roots: [ws] });
  assert.equal(offByDefault.permission, "allow", "shell guard is opt-in");
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ shellGuard: { enabled: true } }));
  const out = runHook("cco-shell-guard.mjs", { hook_event_name: "beforeShellExecution", command: "rm -rf /", workspace_roots: [ws] });
  assert.equal(out.permission, "deny");
  assert.equal(runHook("cco-shell-guard.mjs", { command: "ls", workspace_roots: [ws] }).permission, "allow");
});

test("workspace tier agents are generated with models, idempotently, and never clobber user files", () => {
  const ws = tmpWorkspace();
  const first = writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "inherit", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5" });
  assert.deepEqual(first.map((r) => r.action), ["written", "written", "written", "written", "written"]);
  assert.equal(readWorkspaceAgentModel(ws, "fast-tier"), "composer-2.5");
  assert.ok(fs.readFileSync(path.join(ws, ".cursor", "agents", "composer-2.5-fast.md"), "utf8").includes(GENERATED_MARKER), "named after the model it runs on");
  const second = writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "inherit", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5" });
  assert.deepEqual(second.map((r) => r.action), ["unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
  fs.writeFileSync(path.join(ws, ".cursor", "agents", "claude-opus-5-deep.md"), "---\nname: claude-opus-5-deep\ndescription: mine\nmodel: gpt-5.6-sol-high\n---\ncustom\n");
  const third = writeWorkspaceAgents(ws, { "fast-tier": "gemini-3.8-flash-high", "balanced-tier": "inherit", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "x" });
  assert.equal(third.find((r) => r.role === "deep-tier").action, "skipped_user_file");
  assert.equal(third.find((r) => r.role === "fast-tier").action, "written");
});

test("discovery with injected model list and fake probes picks runnable candidates and restores nothing", () => {
  const ws = tmpWorkspace();
  const models = ["auto", "composer-2.5", "gemini-3.8-flash-high", "cursor-grok-4.6-high", "claude-sonnet-5-thinking-high", "claude-opus-5-thinking-high", "gpt-5.6-sol-high"].map((id) => ({ id, label: id, current: false, default: false }));
  const probeFn = (id) => (id === "composer-2.5" || id === "claude-opus-5-thinking-high" ? { runnable: false, reason: "usage_limit" } : { runnable: true, reason: "ok" });
  const runtime = discover({ workspace: ws, probe: true, writeAgents: true, config, models: { ok: true, models, current: "auto", defaultModel: "auto" }, probeFn });
  assert.equal(runtime.profiles.fast.model, "gemini-3.8-flash-high");
  assert.equal(runtime.profiles.balanced.model, "claude-sonnet-5-thinking-high", "quality-first: Sonnet 5 outranks Grok for balanced");
  assert.equal(runtime.profiles.deep.model, "gpt-5.6-sol-high");
  assert.equal(runtime.discovery.probes["composer-2.5"].reason, "usage_limit");
  assert.equal(readWorkspaceAgentModel(ws, "deep-tier"), "gpt-5.6-sol-high");
  const strict = discover({
    workspace: ws,
    probe: false,
    writeAgents: false,
    config: { ...config, modelOverrides: { fast: "nope-model", balanced: "", deep: "" }, modelOverridePolicy: "strict" },
    models: { ok: true, models, current: "auto", defaultModel: "auto" }
  });
  assert.equal(strict.profiles.fast.model, "inherit");
  assert.ok(strict.health.degraded);
});

test("session start hook injects context and initializes runtime without probes", () => {
  const ws = readyWorkspace({ "fast-tier": "inherit", "balanced-tier": "inherit", "deep-tier": "inherit", "tier-verifier": "inherit" });
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ pricing: { enabled: false }, discovery: { auto: false } }));
  const out = runHook("cco-session-start.mjs", { hook_event_name: "sessionStart", model: "composer-2.5-fast", workspace_roots: [ws] });
  assert.equal(out.continue, true);
  assert.match(out.additional_context, /`fast-tier` on inherit/);
  assert.match(out.additional_context, /Session model: composer-2.5-fast/);
  assert.equal(out.cco.pricing, "disabled");
  assert.equal(out.cco.discovery, "disabled");
});

test("install-hooks writes merge-preserving user/project entries pointing at the dispatcher", async () => {
  const { buildEntries, mergeHooks, installHooks, uninstallHooks, hooksInstalled } = await import("../scripts/cco-install-hooks.mjs");
  const entries = buildEntries();
  assert.equal(entries.preToolUse[0].command, "node .cursor/cco-hook.mjs preToolUse");
  assert.match(entries.preToolUse[0].matcher, /^\^\(Task\|Write/, "per-call hook only for delegations, edits and shell (reads are free)");
  const merged = mergeHooks({ version: 1, hooks: { preToolUse: [{ command: "node other.js" }, { command: "node old/cco-hook.mjs preToolUse" }] } }, entries);
  assert.equal(merged.hooks.preToolUse.filter((e) => e.command === "node other.js").length, 1, "foreign entry preserved");
  assert.equal(merged.hooks.preToolUse.filter((e) => e.command.includes("old/cco-hook")).length, 0, "stale CCO entry replaced");
  const ws = tmpWorkspace();
  const res = installHooks({ workspace: ws });
  assert.ok(fs.existsSync(res.file));
  assert.ok(fs.existsSync(path.join(ws, ".cursor", "cco-hook.mjs")), "shim lives next to hooks.json, outside the ignored state folder");
  assert.equal(hooksInstalled({ workspace: ws }), true);
  const un = uninstallHooks({ workspace: ws });
  assert.equal(un.removed, true);
  assert.equal(fs.existsSync(res.file), false, "file deleted when nothing else remains");
});

test("dispatcher replays the first result when the same hook event is delivered twice", () => {
  const ws = readyWorkspace();
  const payload = { hook_event_name: "preToolUse", conversation_id: "dup-1", generation_id: "g1", tool_use_id: "t1", tool_name: "Task", tool_input: { description: "d", prompt: "CCO-SCORES: complexity=3 risk=9 breadth=2 uncertainty=1 latency=0\nrefund flow", subagent_type: "fast-tier" }, workspace_roots: [ws] };
  const first = runHook("cco-hook.mjs", payload, ["preToolUse"]);
  const second = runHook("cco-hook.mjs", payload, ["preToolUse"]);
  assert.deepEqual(second, first);
  const decisions = fs.readFileSync(workspacePaths(ws).decisionsPath, "utf8").trim().split("\n");
  assert.equal(decisions.length, 1, "the guard acted once");
});

test("dispatcher: two concurrent deliveries of the same event act once and both return the same result", async () => {
  const { spawn } = await import("node:child_process");
  const ws = readyWorkspace();
  const payload = JSON.stringify({ hook_event_name: "preToolUse", conversation_id: "dup-2", generation_id: "g2", tool_use_id: "t2", tool_name: "Task", tool_input: { description: "d", prompt: "CCO-SCORES: complexity=3 risk=9 breadth=2 uncertainty=1 latency=0\nrefund flow", subagent_type: "fast-tier" }, workspace_roots: [ws] });
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scripts, "cco-hook.mjs"), "preToolUse"], { env: { ...process.env, CCO_CURSOR_AGENT_BIN: "cco-nonexistent-binary" } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(out.trim()));
    child.stdin.end(payload);
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a, b);
  assert.equal(JSON.parse(a).updated_input.subagent_type, "claude-opus-5-deep");
  const decisions = fs.readFileSync(workspacePaths(ws).decisionsPath, "utf8").trim().split("\n");
  assert.equal(decisions.length, 1, "the guard acted exactly once");
});

test("agents generated by an older CCO version are refreshed on upgrade; user-authored ones are kept", async () => {
  const { writeWorkspaceAgents } = await import("../scripts/lib/agents.mjs");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-upgrade-"));
  const dir = path.join(ws, ".cursor", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fast-tier.md"), "---\nname: fast-tier\nmodel: old-model\n---\n<!-- generated by cursor-ai-cost-optimizer (CCO). Edit ~/.cursor/cco/config.json and re-run cco-init instead of editing this file. -->\nold body\n");
  fs.writeFileSync(path.join(dir, "deep-tier.md"), "---\nname: deep-tier\nmodel: my-model\n---\nmine\n");
  const result = writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high" });
  assert.match(fs.readFileSync(path.join(dir, "composer-2.5-fast.md"), "utf8"), /model: composer-2\.5/, "older generated file replaced by the model-named one");
  assert.equal(fs.existsSync(path.join(dir, "fast-tier.md")), false, "old generated name swept");
  assert.equal(fs.readFileSync(path.join(dir, "deep-tier.md"), "utf8").includes("mine"), true, "user file untouched");
  assert.equal(fs.existsSync(path.join(dir, "deep-tier.md")), true, "a user file under an old name is never removed");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("cco-init installs the agents from a CRLF checkout of the plugin (Windows autocrlf)", () => {
  const { spawnSync } = require("node:child_process");
  const pluginCopy = fs.mkdtempSync(path.join(os.tmpdir(), "cco-crlf-plugin-"));
  fs.cpSync(path.join(here, ".."), pluginCopy, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes(`${path.sep}test`) });
  for (const f of fs.readdirSync(path.join(pluginCopy, "agents"))) {
    const file = path.join(pluginCopy, "agents", f);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\r?\n/g, "\r\n"));
  }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-crlf-ws-"));
  const res = spawnSync(process.execPath, [path.join(pluginCopy, "scripts", "cco-init.mjs"), "--workspace", ws, "--json"], { encoding: "utf8", env: { ...process.env, CCO_PLUGIN_ROOT: pluginCopy, CCO_CURSOR_AGENT_BIN: "cco-nonexistent-binary" }, timeout: 60_000 });
  assert.equal(res.status, 0, res.stderr);
  const agent = fs.readFileSync(path.join(ws, ".cursor", "agents", "composer-2.5-fast.md"), "utf8");
  assert.match(agent, /^model: composer-2\.5$/m);
  assert.equal(agent.includes("\r"), false, "written agents use LF");
  fs.rmSync(pluginCopy, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

test("user scope: nothing in the repo; ~/.cursor hooks + agents, private state root, pluginPaths on workspaceOpen, pause and uninstall", () => {
  const { spawnSync } = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cco-home-"));
  const root = path.join(home, "ext-storage", "cco");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-user-ws-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CCO_CURSOR_AGENT_BIN: "cco-nonexistent-binary" };
  delete env.CCO_SCOPE;
  delete env.CCO_STATE_ROOT;
  const init = spawnSync(process.execPath, [path.join(scripts, "cco-init.mjs"), "--workspace", ws, "--scope", "user", "--state-root", root, "--json"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(init.status, 0, init.stderr);
  const summary = JSON.parse(init.stdout);
  assert.equal(summary.scope, "user");
  assert.equal(fs.existsSync(path.join(ws, ".cursor")), false, "nothing written into the repo");
  const hooks = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "hooks.json"), "utf8"));
  const cmd = hooks.hooks.preToolUse[0].command;
  assert.match(cmd, /cco-hook\.mjs" preToolUse --scope user --state-root "/);
  assert.match(fs.readFileSync(path.join(home, ".cursor", "agents", "composer-2.5-fast.md"), "utf8"), /^model: composer-2\.5$/m);
  assert.ok(fs.existsSync(path.join(root, "plugin", ".cursor-plugin", "plugin.json")), "runtime plugin for pluginPaths");
  assert.equal(fs.existsSync(path.join(root, "plugin", "rules")), false, "the rule rides the sessionStart context, not the plugin path (no reload needed)");
  assert.equal(fs.existsSync(path.join(root, "plugin", "agents")), false, "runtime plugin carries no agents (user agents win)");
  const run = (event, payload) => {
    const res = spawnSync(process.execPath, [path.join(scripts, "cco-hook.mjs"), event, "--scope", "user", "--state-root", root], { input: JSON.stringify(payload), encoding: "utf8", env, cwd: path.join(home, ".cursor"), timeout: 40_000 });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout.trim().split(/\r?\n/).filter(Boolean).pop());
  };
  const cheap = run("sessionStart", { hook_event_name: "sessionStart", conversation_id: "u-cheap", model: "composer-2.5", workspace_roots: [ws] });
  assert.match(cheap.additional_context, /short form/, "a cheap chat model gets the short rule");
  assert.doesNotMatch(cheap.additional_context, /## Score/);
  const start = run("sessionStart", { hook_event_name: "sessionStart", conversation_id: "u0", model: "claude-opus-5-thinking-high", workspace_roots: [ws] });
  assert.match(start.additional_context, /# CCO routing/, "user scope: the routing rule is delivered through the session context");
  const open = run("workspaceOpen", { hook_event_name: "workspaceOpen", workspace_roots: [ws] });
  assert.deepEqual(open.pluginPaths, [path.join(root, "plugin")]);
  const task = run("preToolUse", { hook_event_name: "preToolUse", tool_name: "Task", conversation_id: "u1", tool_input: { description: "d", prompt: "CCO-SCORES: complexity=2 risk=9 breadth=1 uncertainty=0 latency=0\nrefund flow", subagent_type: "fast-tier" }, workspace_roots: [ws] });
  assert.equal(task.updated_input.subagent_type, "claude-opus-5-deep", "guard reroutes in user scope");
  assert.ok(fs.existsSync(path.join(root, "workspaces")), "state lives under the private root");
  assert.equal(fs.existsSync(path.join(ws, ".cursor")), false, "still nothing in the repo after hooks ran");
  // precedence: a project-level setup in the workspace makes the user-scope hooks inert there
  fs.mkdirSync(path.join(ws, ".cursor", "agents"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "agents", "fast-tier.md"), "---\nname: fast-tier\nmodel: composer-2.5\n---\nx\n");
  fs.writeFileSync(path.join(ws, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: "node .cursor/cco-hook.mjs preToolUse" }] } }));
  assert.deepEqual(run("workspaceOpen", { hook_event_name: "workspaceOpen", workspace_roots: [ws] }), {}, "project scope wins: no plugin path from the user scope");
  fs.rmSync(path.join(ws, ".cursor"), { recursive: true, force: true });
  const pause = spawnSync(process.execPath, [path.join(scripts, "cco-init.mjs"), "--workspace", ws, "--scope", "user", "--state-root", root, "--disable"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(pause.status, 0, pause.stderr);
  assert.deepEqual(run("workspaceOpen", { hook_event_name: "workspaceOpen", workspace_roots: [ws] }), {}, "paused project gets no plugin path");
  const un = spawnSync(process.execPath, [path.join(scripts, "cco-init.mjs"), "--workspace", ws, "--scope", "user", "--state-root", root, "--uninstall"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(path.join(home, ".cursor", "hooks.json")), false, "hooks file removed when only CCO entries were in it");
  assert.equal(fs.existsSync(path.join(home, ".cursor", "agents", "composer-2.5-fast.md")), false);
  assert.equal(fs.existsSync(root), false, "private state root removed");
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

test("session start never waits on the network: a stale price table is refreshed by a detached worker", () => {
  const ws = readyWorkspace();
  const paths = workspacePaths(ws);
  fs.mkdirSync(path.dirname(paths.pricingPath), { recursive: true });
  const bundled = JSON.parse(fs.readFileSync(path.join(here, "..", "config", "pricing.json"), "utf8"));
  fs.writeFileSync(paths.pricingPath, JSON.stringify({ ...bundled, fetchedAt: "2020-01-01T00:00:00.000Z" }));
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  // Connection refused locally: the worker fails fast, so the test can watch it finish.
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ pricing: { sourceUrl: "http://127.0.0.1:9/pricing.md" }, discovery: { auto: false } }));
  const started = Date.now();
  const out = runHook("cco-session-start.mjs", { hook_event_name: "sessionStart", conversation_id: "bg-1", workspace_roots: [ws] });
  const elapsed = Date.now() - started;
  assert.equal(out.continue, true);
  assert.equal(out.cco.pricing, "scheduled");
  assert.ok(elapsed < 3000, `sessionStart took ${elapsed} ms with a stale price table`);
  const lock = path.join(path.dirname(paths.pricingPath), "refresh.lock");
  const again = runHook("cco-session-start.mjs", { hook_event_name: "sessionStart", conversation_id: "bg-2", workspace_roots: [ws] });
  assert.equal(again.cco.pricing, "scheduled");
  // The detached worker runs, logs its outcome, and clears the lock.
  const deadline = Date.now() + 15_000;
  while (fs.existsSync(lock) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.equal(fs.existsSync(lock), false, "refresh worker should clear the lock");
  const log = fs.readFileSync(paths.hooksLogPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const refresh = log.find((r) => r.event === "refresh");
  assert.ok(refresh, "refresh worker should log its run");
  assert.equal(refresh.pricing.action, "failed");
  assert.equal(refresh.pricing.keptExisting, true);
});

test("session start ignores an empty window (workspace_roots present but empty)", () => {
  const out = runHook("cco-session-start.mjs", { hook_event_name: "sessionStart", conversation_id: "empty-1", workspace_roots: [] });
  assert.equal(out.continue, true);
  assert.equal(out.cco, "no workspace root in payload");
  assert.equal(out.additional_context, undefined);
});

test("cli version is cached per binary identity (no CLI startup on every chat)", async () => {
  const { cliVersion } = await import("../scripts/lib/models.mjs");
  const dir = tmpWorkspace();
  const counter = path.join(dir, "calls");
  const bin = path.join(dir, process.platform === "win32" ? "fake-agent.cmd" : "fake-agent");
  if (process.platform === "win32") {
    fs.writeFileSync(bin, `@echo off\r\necho x>>"${counter}"\r\necho 2026.01.01-test\r\n`);
  } else {
    fs.writeFileSync(bin, `#!/bin/sh\necho x >> "${counter}"\necho 2026.01.01-test\n`, { mode: 0o755 });
  }
  const prev = process.env.CCO_CURSOR_AGENT_BIN;
  process.env.CCO_CURSOR_AGENT_BIN = bin;
  try {
    assert.equal(cliVersion(), "2026.01.01-test");
    assert.equal(cliVersion(), "2026.01.01-test");
    assert.equal(fs.readFileSync(counter, "utf8").trim().split(/\s+/).length, 1, "second call must come from the cache");
  } finally {
    if (prev === undefined) delete process.env.CCO_CURSOR_AGENT_BIN; else process.env.CCO_CURSOR_AGENT_BIN = prev;
  }
});

test("discovery without a usable CLI still maps real tier models (never all-inherit for IDE-only users)", () => {
  const ws = tmpWorkspace();
  let probes = 0;
  const probeFn = () => {
    probes += 1;
    return { runnable: false, reason: "auth_required" };
  };
  // CLI listing failed (not installed / not logged in) and the extension asked for probing.
  const runtime = discover({ workspace: ws, probe: true, writeAgents: false, config, models: { ok: false, error: "exit 1: Authentication required" }, probeFn });
  assert.equal(probes, 0, "no probe can succeed without a CLI; none should run");
  for (const tier of ["fast", "balanced", "deep"]) {
    assert.notEqual(runtime.profiles[tier].model, "inherit", `${tier} must get a real model`);
    assert.equal(runtime.profiles[tier].source, "ranked_unprobed");
  }
  assert.match(JSON.stringify(runtime), /not verified/);
});

test("discovery stops probing on an account-level failure and keeps the best candidates unverified", () => {
  const ws = tmpWorkspace();
  const models = ["composer-2.5", "claude-sonnet-5-thinking-high", "claude-opus-5-thinking-high", "gpt-5.6-sol-high"].map((id) => ({ id, label: id }));
  let probes = 0;
  const probeFn = () => {
    probes += 1;
    return { runnable: false, reason: "auth_required" };
  };
  const runtime = discover({ workspace: ws, probe: true, writeAgents: false, config, models: { ok: true, models, current: "auto", defaultModel: "auto" }, probeFn });
  assert.equal(probes, 1, "the first account-level failure ends probing");
  for (const tier of ["fast", "balanced", "deep"]) {
    assert.notEqual(runtime.profiles[tier].model, "inherit", `${tier} must get a real model`);
  }
});

test("paused project: a cco-* delegation is turned back into in-chat work and the session is told so", () => {
  const ws = readyWorkspace();
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ enabled: false }));
  const guard = runHook("cco-task-guard.mjs", {
    hook_event_name: "preToolUse", conversation_id: "p1", tool_name: "Task",
    tool_input: { subagent_type: "fast-tier", prompt: "CCO-SCORES: complexity=1 risk=1 breadth=1 uncertainty=0 latency=0\nAdd x" }, workspace_roots: [ws]
  });
  assert.equal(guard.permission, "deny");
  assert.match(guard.agent_message, /paused/);
  const other = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "p2", tool_name: "Task", tool_input: { subagent_type: "explore", prompt: "look" }, workspace_roots: [ws] });
  assert.equal(other.permission, "allow", "non-CCO subagents are not CCO's business while paused");
  const start = runHook("cco-session-start.mjs", { hook_event_name: "sessionStart", conversation_id: "p3", workspace_roots: [ws] });
  assert.equal(start.cco, "workspace_opt_out");
  assert.match(start.additional_context, /paused/);
});

test("a failed DEEP subagent (usage limit) hands the task back to the chat with an honest footer", () => {
  const ws = readyWorkspace();
  createSession({ workspace: ws, conversationId: "deep-fail", model: "cursor-grok-4.6-high" });
  const out = runHook("cco-task-result.mjs", {
    hook_event_name: "subagentStop", conversation_id: "deep-fail", subagent_type: "deep-tier", model: "claude-opus-5-thinking-high",
    status: "error", summary: "ActionRequiredError: You've hit your usage limit for Opus", workspace_roots: [ws]
  });
  assert.match(out.followup_message, /deep-tier did not complete/);
  assert.match(out.followup_message, /do the task directly in this chat on cursor-grok-4\.6-high/i);
  // A DEEP subagent that ran and then errored (not a startup refusal) has nothing above it: the chat finishes.
  const ran = runHook("cco-task-result.mjs", {
    hook_event_name: "subagentStop", conversation_id: "deep-fail", subagent_type: "deep-tier", model: "claude-opus-5-thinking-high",
    status: "error", message_count: 4, tool_call_count: 3, summary: "crashed midway", workspace_roots: [ws]
  });
  assert.match(ran.followup_message, /do the task directly in this chat on cursor-grok-4\.6-high/i);
});

test("a subagent that dies at startup puts its model on cooldown; later delegations step down a tier", async () => {
  const { loadJointState } = await import("../scripts/lib/state.mjs");
  const ws = readyWorkspace();
  const paths = workspacePaths(ws);
  createSession({ workspace: ws, conversationId: "cool-1", model: "cursor-grok-4.6-high" });
  runHook("cco-task-result.mjs", {
    hook_event_name: "subagentStop", conversation_id: "cool-1", subagent_type: "deep-tier", model: "claude-opus-5-thinking-high",
    status: "error", duration_ms: 1163, message_count: 0, tool_call_count: 0, workspace_roots: [ws]
  });
  const limitsFile = path.join(path.dirname(paths.jointStatePath), "model-limits.json");
  const limits = JSON.parse(fs.readFileSync(limitsFile, "utf8"));
  assert.ok(limits["claude-opus-5-thinking-high"], "the failed model is recorded as limited");
  const guard = runHook("cco-task-guard.mjs", {
    hook_event_name: "preToolUse", conversation_id: "cool-2", tool_name: "Task",
    tool_input: { subagent_type: "deep-tier", prompt: "CCO-SCORES: complexity=4 risk=8 breadth=3 uncertainty=2 latency=0\n[cco:deep]\nRotate the production signing key" }, workspace_roots: [ws]
  });
  assert.equal(guard.permission, "allow");
  assert.equal(guard.updated_input.subagent_type, "claude-sonnet-5-balanced", "DEEP steps down to BALANCED while its model is limited");
  assert.match(guard.user_message, /usage limit/);
  // A completed run does not mark anything.
  runHook("cco-task-result.mjs", { hook_event_name: "subagentStop", conversation_id: "cool-3", subagent_type: "fast-tier", model: "composer-2.5", status: "completed", message_count: 3, tool_call_count: 2, workspace_roots: [ws] });
  assert.equal(JSON.parse(fs.readFileSync(limitsFile, "utf8"))["composer-2.5"], undefined);
});

test("a DEEP subagent refused at startup retries once on BALANCED; when that is limited too, the chat finishes it", () => {
  const ws = readyWorkspace();
  const paths = workspacePaths(ws);
  createSession({ workspace: ws, conversationId: "down-1", model: "cursor-grok-4.6-high" });
  const first = runHook("cco-task-result.mjs", { hook_event_name: "subagentStop", conversation_id: "down-1", subagent_type: "deep-tier", model: "claude-opus-5-thinking-high", status: "error", duration_ms: 900, message_count: 0, tool_call_count: 0, workspace_roots: [ws] });
  assert.match(first.followup_message, /delegate this same task once to claude-sonnet-5-balanced \(claude-sonnet-5-thinking-high\)/);
  assert.doesNotMatch(first.followup_message, /escalating to DEEP/);
  const second = runHook("cco-task-result.mjs", { hook_event_name: "subagentStop", conversation_id: "down-1", subagent_type: "balanced-tier", model: "claude-sonnet-5-thinking-high", status: "error", duration_ms: 500, message_count: 0, tool_call_count: 0, workspace_roots: [ws] });
  assert.match(second.followup_message, /delegate this same task once to composer-2\.5-fast \(composer-2\.5\)/, "BALANCED refused: try FAST, never escalate up");
  const third = runHook("cco-task-result.mjs", { hook_event_name: "subagentStop", conversation_id: "down-1", subagent_type: "fast-tier", model: "composer-2.5", status: "error", duration_ms: 500, message_count: 0, tool_call_count: 0, workspace_roots: [ws] });
  assert.match(third.followup_message, /do the task directly in this chat on cursor-grok-4\.6-high/i, "nothing lower: the chat finishes it");
  const guard = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "down-2", tool_name: "Task", tool_input: { subagent_type: "deep-tier", prompt: "CCO-SCORES: complexity=4 risk=8 breadth=3 uncertainty=2 latency=0\n[cco:deep]\nRotate the production signing key" }, workspace_roots: [ws] });
  assert.equal(guard.permission, "allow", "all tiers limited: the delegation is left alone");
  assert.equal(paths.jointStatePath.endsWith("joint-state.json"), true);
});

test("gate messages name the model that will actually run while a tier model is on cooldown", async () => {
  const { markModelLimited, limitsPathFor } = await import("../scripts/lib/state.mjs");
  const ws = readyWorkspace();
  const paths = workspacePaths(ws);
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ enforcement: { mode: "strict" } }));
  markModelLimited({ limitsPath: limitsPathFor(paths.jointStatePath), model: "claude-opus-5-thinking-high", minutes: 60 });
  createSession({ workspace: ws, conversationId: "gate-lim", model: "cursor-grok-4.6-high" });
  runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "gate-lim", prompt: "[cco:deep] rotate the production signing key", workspace_roots: [ws] });
  const out = runHook("cco-tool-gate.mjs", { hook_event_name: "preToolUse", conversation_id: "gate-lim", tool_name: "Write", tool_input: { file_path: "x" }, workspace_roots: [ws] });
  assert.equal(out.permission, "deny");
  assert.match(out.agent_message, /runs on claude-sonnet-5-thinking-high/, "DEEP is limited: the message names BALANCED's model");
  assert.doesNotMatch(String(out.user_message), /claude-opus/);
});

test("legacy cco-* names: old rules still route, and generated cco-*.md files are replaced on setup", async () => {
  const { tierFor } = await import("../scripts/lib/models.mjs");
  assert.equal(tierFor("cco-fast"), "fast");
  assert.equal(tierFor("fast-tier"), "fast");
  const ws = tmpWorkspace();
  const dir = path.join(ws, ".cursor", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cco-fast.md"), `---\nname: cco-fast\nmodel: composer-2.5\n---\n${GENERATED_MARKER}\nold`);
  fs.writeFileSync(path.join(dir, "cco-mine.md"), "---\nname: cco-mine\n---\nmine");
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "inherit", "deep-tier": "inherit", "tier-verifier": "inherit", "fast-research": "composer-2.5" });
  assert.equal(fs.existsSync(path.join(dir, "cco-fast.md")), false, "generated legacy agent removed");
  assert.equal(fs.existsSync(path.join(dir, "cco-mine.md")), true, "user file kept");
  assert.equal(fs.existsSync(path.join(dir, "composer-2.5-fast.md")), true);
});

test("a model refused repeatedly across cooldowns becomes unavailable: discovery remaps its tier and a forced refresh is scheduled", async () => {
  const { markModelLimited, modelUnavailable, unavailableModels } = await import("../scripts/lib/state.mjs");
  const ws = readyWorkspace();
  const paths = workspacePaths(ws);
  fs.mkdirSync(path.dirname(paths.limitsPath), { recursive: true });
  // Two refusals a day apart, then a third: a usage limit does not look like that, a plan restriction does.
  fs.writeFileSync(paths.limitsPath, JSON.stringify({ "claude-sonnet-5-thinking-high": { until: "2020-01-01T00:00:00.000Z", failures: 2, firstFailureAt: "2020-01-01T00:00:00.000Z" } }));
  markModelLimited({ limitsPath: paths.limitsPath, model: "claude-sonnet-5-thinking-high", minutes: 1 });
  assert.equal(modelUnavailable(paths.limitsPath, "claude-sonnet-5-thinking-high"), true);
  assert.deepEqual(unavailableModels(paths.limitsPath), ["claude-sonnet-5-thinking-high"]);
  const models = ["composer-2.5", "claude-sonnet-5-thinking-high", "cursor-grok-4.6-high", "claude-opus-5-thinking-high"].map((id) => ({ id, label: id }));
  const runtime = discover({ workspace: ws, probe: false, writeAgents: false, config, models: { ok: true, models, current: "auto", defaultModel: "auto" } });
  assert.notEqual(runtime.profiles.balanced.model, "claude-sonnet-5-thinking-high", "the refused model is no longer a candidate");
  assert.equal(runtime.profiles.balanced.model, "cursor-grok-4.6-high");
  // The third refusal at run time schedules a remap without waiting for the 24 h refresh.
  fs.writeFileSync(paths.limitsPath, JSON.stringify({ "claude-opus-5-thinking-high": { until: "2020-01-01T00:00:00.000Z", failures: 2, firstFailureAt: "2020-01-01T00:00:00.000Z" } }));
  createSession({ workspace: ws, conversationId: "unav-1", model: "cursor-grok-4.6-high" });
  runHook("cco-task-result.mjs", { hook_event_name: "subagentStop", conversation_id: "unav-1", subagent_type: "deep-tier", model: "claude-opus-5-thinking-high", status: "error", duration_ms: 700, message_count: 0, tool_call_count: 0, workspace_roots: [ws] });
  assert.ok(fs.existsSync(path.join(path.dirname(paths.pricingPath), "refresh.lock")), "forced refresh scheduled");
});

test("user-scope global config (tier models chosen for all projects) layers between defaults and the project file", async () => {
  const { loadConfig } = await import("../scripts/lib/config.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cco-root-"));
  const ws = tmpWorkspace();
  const prevScope = process.env.CCO_SCOPE;
  const prevRoot = process.env.CCO_STATE_ROOT;
  process.env.CCO_SCOPE = "user";
  process.env.CCO_STATE_ROOT = root;
  try {
    fs.writeFileSync(path.join(root, "cco.json"), JSON.stringify({ modelOverrides: { balanced: "gpt-5.6-terra-high" } }));
    const cfg = loadConfig(ws);
    assert.equal(cfg.modelOverrides.balanced, "gpt-5.6-terra-high");
    assert.equal(cfg._source, "user");
    const paths = workspacePaths(ws);
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(paths.configPath, JSON.stringify({ modelOverrides: { balanced: "cursor-grok-4.6-high" } }));
    assert.equal(loadConfig(ws).modelOverrides.balanced, "cursor-grok-4.6-high", "the project file wins");
  } finally {
    if (prevScope === undefined) delete process.env.CCO_SCOPE; else process.env.CCO_SCOPE = prevScope;
    if (prevRoot === undefined) delete process.env.CCO_STATE_ROOT; else process.env.CCO_STATE_ROOT = prevRoot;
  }
});

test("dispatcher: two subagents stopping in the same generation are two events, not a replay", async () => {
  const { dispatch } = await import("../scripts/cco-hook.mjs");
  const ws = readyWorkspace();
  createSession({ workspace: ws, conversationId: "dd-1", model: "cursor-grok-4.6-high" });
  const base = { hook_event_name: "subagentStop", conversation_id: "dd-1", generation_id: "gen-1", workspace_roots: [ws], duration_ms: 500, message_count: 0, tool_call_count: 0 };
  const first = JSON.parse(await dispatch("subagentStop", JSON.stringify({ ...base, subagent_id: "a", subagent_type: "fast-research", status: "completed" })));
  assert.equal(first.followup_message, undefined);
  const second = JSON.parse(await dispatch("subagentStop", JSON.stringify({ ...base, subagent_id: "b", subagent_type: "deep-tier", model: "claude-opus-5-thinking-high", status: "error" })));
  assert.match(String(second.followup_message), /deep-tier could not start/, "the second stop must be processed on its own");
  const replay = JSON.parse(await dispatch("subagentStop", JSON.stringify({ ...base, subagent_id: "b", subagent_type: "deep-tier", model: "claude-opus-5-thinking-high", status: "error" })));
  assert.match(String(replay.followup_message), /deep-tier could not start/, "an exact duplicate replays the same answer");
});

test("a tier model the user picked is used as chosen, even when it is not cheaper than the chat model", () => {
  const ws = readyWorkspace({ "fast-tier": "claude-opus-5-thinking-high", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5", "fast-research": "composer-2.5" });
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ modelOverrides: { fast: "claude-opus-5-thinking-high" } }));
  createSession({ workspace: ws, conversationId: "pick-1", model: "cursor-grok-4.6-high" });
  const out = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "pick-1", model: "cursor-grok-4.6-high", tool_name: "Task", tool_input: { subagent_type: "claude-opus-5-fast", prompt: "CCO-SCORES: complexity=1 risk=1 breadth=1 uncertainty=0 latency=0\nAdd sub()" }, workspace_roots: [ws] });
  assert.equal(out.permission, "allow", "not turned into in-chat work");
  assert.doesNotMatch(String(out.user_message), /Staying in chat/);
  const start = runHook("cco-session-start.mjs", { hook_event_name: "sessionStart", conversation_id: "pick-2", model: "cursor-grok-4.6-high", workspace_roots: [ws] });
  assert.doesNotMatch(start.additional_context, /answer simple requests directly/);
  assert.match(start.additional_context, /chosen by the user/);
});
