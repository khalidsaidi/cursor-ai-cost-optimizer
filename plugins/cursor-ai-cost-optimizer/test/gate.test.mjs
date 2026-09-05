import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gateDecision } from "../scripts/cco-tool-gate.mjs";
import { loadDefaults } from "../scripts/lib/config.mjs";
import { loadPricing } from "../scripts/lib/pricing.mjs";
import { createSession, loadSession, userPromptFromTranscript } from "../scripts/lib/session.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
import { workspacePaths } from "../scripts/lib/common.mjs";
import { writeWorkspaceAgents, readWorkspaceAgentModel, GENERATED_MARKER } from "../scripts/lib/agents.mjs";

const config = loadDefaults();
const pricing = loadPricing(null);
const models = { fast: "composer-2.5", balanced: "cursor-grok-4.6-high", deep: "claude-opus-5-thinking-high" };

function session(overrides = {}) {
  return { conversation_id: "c1", model: "claude-opus-5-thinking-high", delegations: [], denials: 0, ...overrides };
}

function runHook(script, payload) {
  const res = spawnSync(process.execPath, [path.join(scripts, script)], { input: JSON.stringify(payload), encoding: "utf8", timeout: 20_000 });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

test("router mode: expensive parent is denied everything but Task before delegation, and relays after", () => {
  const verdict = gateDecision({ toolName: "Write", session: session(), config, pricing, models, prompt: "Create utils/slugify.js with a slugify function and a test" });
  assert.equal(verdict.action, "deny");
  assert.equal(verdict.phase, "pre");
  assert.match(verdict.reason, /^cost_session_/);
  assert.equal(verdict.tier, "fast");
  assert.equal(verdict.model, "composer-2.5");
  const read = gateDecision({ toolName: "Read", session: session(), config, pricing, models, prompt: "add helper" });
  assert.equal(read.action, "deny", "router mode also blocks context gathering on the expensive model");
  const post = gateDecision({ toolName: "Read", session: session({ delegations: [{ agent: "fast-tier" }] }), config, pricing, models, prompt: "add helper" });
  assert.equal(post.action, "deny");
  assert.equal(post.reason, "relay_only_after_delegation");
  assert.equal(gateDecision({ toolName: "Task", session: session(), config, pricing, models, prompt: "x" }).reason, "task_handled_by_guard");
  const relaxed = gateDecision({ toolName: "Read", session: session({ delegations: [{ agent: "fast-tier" }] }), config: { ...config, enforcement: { ...config.enforcement, relayOnly: false } }, pricing, models, prompt: "x" });
  assert.equal(relaxed.reason, "already_delegated");
  const risky = gateDecision({ toolName: "Edit", session: session(), config, pricing, models, prompt: "Rotate the production OAuth secret and payment webhook signing key" });
  assert.equal(risky.action, "allow", "deep tier model equals the chat model: no delegation overhead");
  assert.equal(risky.reason, "tier_deep_not_cheaper_than_session");
  const balanced = gateDecision({ toolName: "Edit", session: session(), config, pricing, models, prompt: "Refactor src/cart.js so coupon rules live in a table and add tests for it" });
  assert.equal(balanced.action, "deny");
  assert.equal(balanced.tier, "balanced");
});

test("lenient mode: cheap parent may read and do ordinary work, but risky work is redirected to deep", () => {
  const cheap = session({ model: "composer-2.5" });
  assert.equal(gateDecision({ toolName: "Read", session: cheap, config, pricing, models, prompt: "add a slugify helper" }).action, "allow");
  assert.equal(gateDecision({ toolName: "Write", session: cheap, config, pricing, models, prompt: "add a slugify helper" }).reason, "no_savings_expected");
  const risky = gateDecision({ toolName: "Edit", session: cheap, config, pricing, models, prompt: "Rotate the production OAuth secrets and payment webhook signing keys with rollback" });
  assert.equal(risky.action, "deny");
  assert.equal(risky.tier, "deep");
  assert.match(risky.reason, /^quality_/);
  assert.equal(gateDecision({ toolName: "Write", session: session({ model: "composer-2.5", delegations: [{ agent: "deep-tier" }] }), config, pricing, models, prompt: "x" }).reason, "already_delegated");
});

test("gate: subagents, overrides, escape hatch and modes", () => {
  assert.equal(gateDecision({ toolName: "Write", session: null, config, pricing, models, prompt: "x" }).reason, "not_a_parent_conversation");
  assert.equal(gateDecision({ toolName: "Write", session: session({ denials: 2 }), config, pricing, models, prompt: "x" }).reason, "escape_hatch_after_denials");
  assert.equal(gateDecision({ toolName: "Write", session: session(), config, pricing, models, prompt: "[cco:off] just do it here" }).reason, "user_disabled");
  const forced = gateDecision({ toolName: "Shell", session: session({ model: "composer-2.5" }), config, pricing, models, prompt: "[cco:deep] tidy README" });
  assert.equal(forced.action, "deny");
  assert.equal(forced.tier, "deep");
  assert.equal(gateDecision({ toolName: "Write", session: session({ model: "composer-2.5" }), config, pricing, models, prompt: "[cco:fast] tidy README" }).reason, "override_matches_session_model");
  assert.equal(gateDecision({ toolName: "Write", session: session(), config, pricing, models, prompt: "[cco:deep] tidy README" }).reason, "override_matches_session_model");
  assert.equal(gateDecision({ toolName: "Write", session: session(), config: { ...config, enforcement: { requireDelegation: "never" } }, pricing, models, prompt: "x" }).reason, "enforcement_off");
  assert.equal(gateDecision({ toolName: "Write", session: session({ model: "composer-2.5" }), config: { ...config, enforcement: { requireDelegation: "always" } }, pricing, models, prompt: "x" }).reason, "require_delegation_always");
  assert.equal(gateDecision({ toolName: "Write", session: session({ is_background_agent: true }), config, pricing, models, prompt: "x" }).reason, "background_agent");
});

test("gate: no delegation demanded when the tier model is inherit or equals the session model", () => {
  const inherit = { fast: "inherit", balanced: "inherit", deep: "inherit" };
  assert.equal(gateDecision({ toolName: "Write", session: session(), config, pricing, models: inherit, prompt: "add helper" }).action, "allow");
  assert.equal(gateDecision({ toolName: "Write", session: session({ model: "claude-opus-5-thinking-high" }), config, pricing, models: { ...models, fast: "claude-opus-5-thinking-high" }, prompt: "add helper" }).action, "allow");
});

test("gate hook process: end to end with session state, transcript prompt, denial counting and delegation reset", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-gate-"));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "cursor-grok-4.6-high", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5" });
  const transcript = path.join(ws, "transcript.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<timestamp>now</timestamp>\n<user_query>\nCreate utils/slugify.js and a test\n</user_query>" }] } })}\n`);
  assert.equal(userPromptFromTranscript(transcript), "Create utils/slugify.js and a test");

  createSession({ workspace: ws, conversationId: "conv-A", model: "claude-opus-5-thinking-high" });
  const base = { hook_event_name: "preToolUse", conversation_id: "conv-A", tool_name: "Write", tool_input: { file_path: "x" }, workspace_roots: [ws], transcript_path: transcript };
  const first = runHook("cco-tool-gate.mjs", base);
  assert.equal(first.permission, "allow", "advise-first: the call goes through");
  assert.match(first.agent_message, /CCO \(advice, this call is allowed\)/);
  assert.match(first.agent_message, /subagent_type="composer-2\.5-fast"/);
  assert.match(first.agent_message, /CCO-SCORES: complexity=/);
  const second = runHook("cco-tool-gate.mjs", base);
  assert.equal(second.permission, "allow");
  assert.equal(second.agent_message, undefined, "the same advice is not repeated");
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ enforcement: { mode: "strict" } }));
  const strict1 = runHook("cco-tool-gate.mjs", base);
  assert.equal(strict1.permission, "deny", "strict mode blocks");
  const strict2 = runHook("cco-tool-gate.mjs", base);
  assert.equal(strict2.permission, "deny");
  const strict3 = runHook("cco-tool-gate.mjs", base);
  assert.equal(strict3.permission, "allow", "escape hatch after two denials in strict mode");
  assert.match(strict3.agent_message, /runs in this chat on claude-opus-5-thinking-high/, "honest statement when the model never delegated");
  assert.match(strict3.user_message, /Working in chat/);
  const strict4 = runHook("cco-tool-gate.mjs", base);
  assert.equal(strict4.agent_message, undefined, "the in-chat footer is given once");
  assert.equal(loadSession(ws, "conv-A").denials, 2);
  fs.unlinkSync(path.join(ws, ".cursor", "cco.json"));

  createSession({ workspace: ws, conversationId: "conv-B", model: "claude-opus-5-thinking-high" });
  const guard = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-B", tool_name: "Task", tool_input: { description: "d", prompt: "CCO-SCORES: complexity=1 risk=1 breadth=0 uncertainty=0 latency=5\nmake helper", subagent_type: "fast-tier" }, workspace_roots: [ws] });
  assert.equal(guard.permission, "allow");
  assert.equal(loadSession(ws, "conv-B").delegations.length, 1);
  const afterDelegation = runHook("cco-tool-gate.mjs", { ...base, conversation_id: "conv-B" });
  assert.equal(afterDelegation.permission, "allow", "advise-first: relay advice attached, call allowed");
  assert.match(afterDelegation.agent_message, /relaying the subagent's final message verbatim/);
  const cascade = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-B", tool_name: "Task", tool_input: { description: "d", prompt: "CCO-SCORES: complexity=3 risk=1 breadth=0 uncertainty=0 latency=0\nescalated", subagent_type: "balanced-tier" }, workspace_roots: [ws] });
  assert.equal(cascade.permission, "allow");

  const subagent = runHook("cco-tool-gate.mjs", { ...base, conversation_id: "unknown-subagent-conv" });
  assert.equal(subagent.permission, "allow");
});

test("session start hook creates session state for the conversation", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-sess-"));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "inherit", "deep-tier": "inherit", "tier-verifier": "inherit" });
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ pricing: { enabled: false }, discovery: { auto: false } }));
  const out = runHook("cco-session-start.mjs", { hook_event_name: "sessionStart", conversation_id: "conv-S", model: "gpt-5.6-sol-high", workspace_roots: [ws] });
  assert.equal(out.continue, true);
  const session = loadSession(ws, "conv-S");
  assert.equal(session.model, "gpt-5.6-sol-high");
  assert.deepEqual(session.delegations, []);
});

test("session start hook re-creates missing workspace agents from a cached runtime", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-sess2-"));
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ pricing: { enabled: false } }));
  writeWorkspaceAgents(ws, { "fast-tier": "inherit", "balanced-tier": "inherit", "deep-tier": "inherit", "tier-verifier": "inherit" });
  fs.mkdirSync(workspacePaths(ws).ccoDir, { recursive: true });
  fs.writeFileSync(
    workspacePaths(ws).runtimePath,
    JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(), cli: { version: null }, profiles: { fast: { model: "composer-2.5" }, balanced: { model: "cursor-grok-4.6-high" }, deep: { model: "claude-opus-5-thinking-high" } }, verifier: { tier: "balanced", model: "cursor-grok-4.6-high" }, health: { degraded: false, notes: [] } })
  );
  const out = runHook("cco-session-start.mjs", { hook_event_name: "sessionStart", conversation_id: "conv-R", model: "composer-2.5", workspace_roots: [ws] });
  assert.equal(out.cco.discovery, "cached");
  assert.equal(readWorkspaceAgentModel(ws, "fast-tier"), "composer-2.5", "workspace agents re-mapped from the cached runtime");
  assert.match(out.additional_context, /`claude-opus-5-deep` on claude-opus-5-thinking-high/);
});

test("gate refines a placeholder session model from a later hook payload and applies router mode for Auto", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-gate2-"));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5" });
  createSession({ workspace: ws, conversationId: "conv-ide", model: "auto" });
  const first = runHook("cco-tool-gate.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-ide", model: "", tool_name: "Write", tool_input: {}, workspace_roots: [ws] });
  assert.equal(first.permission, "allow", "advise-first: allowed, with routing advice (Auto is priced above the FAST tier)");
  assert.match(first.agent_message, /CCO \(advice/);
  const refined = runHook("cco-tool-gate.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-ide", model: "composer-2.5", tool_name: "Write", tool_input: {}, workspace_roots: [ws] });
  assert.equal(loadSession(ws, "conv-ide").model, "composer-2.5");
  assert.equal(refined.permission, "allow", "once the concrete cheap model is known, ordinary work stays in the chat");
});

test("router mode answers FAST questions directly but still routes FAST work", () => {
  const q = gateDecision({ toolName: "Read", session: session(), config, pricing, models, prompt: "In two sentences, what does src/debounce.js do?" });
  assert.equal(q.action, "allow");
  assert.equal(q.reason, "question_answered_directly");
  const qWrite = gateDecision({ toolName: "Write", session: session(), config, pricing, models, prompt: "What does src/debounce.js do?" });
  assert.equal(qWrite.action, "deny");
  const work = gateDecision({ toolName: "Read", session: session(), config, pricing, models, prompt: "Create utils/slugify.js and a test for it" });
  assert.equal(work.action, "deny");
});

test("IDE replay: workspaceOpen + first prompt on Auto → router mode → delegate → relay; cheap chat keeps FAST work", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-ide-"));
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ pricing: { enabled: false }, discovery: { auto: false } }));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5" });
  const open = runHook("cco-workspace-open.mjs", { hook_event_name: "workspaceOpen", workspace_roots: [ws] });
  assert.deepEqual(open, {});
  const prompt = runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "ide-A", model: "default", prompt: "Create utils/slugify.js exporting slugify(str) and a node:test for it, then run node --test utils/", workspace_roots: [ws] });
  assert.equal(prompt.continue, true);
  const grep = runHook("cco-tool-gate.mjs", { hook_event_name: "preToolUse", conversation_id: "ide-A", model: "default", tool_name: "Grep", tool_input: { pattern: "slugify" }, workspace_roots: [ws] });
  assert.equal(grep.permission, "allow", "advise-first");
  assert.match(grep.agent_message, /subagent_type="composer-2\.5-fast"/);
  const task = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "ide-A", model: "default", tool_name: "Task", tool_input: { description: "slugify", prompt: "CCO-SCORES: complexity=3 risk=0 breadth=1 uncertainty=0 latency=2\nCreate utils/slugify.js ...", subagent_type: "fast-tier" }, workspace_roots: [ws] });
  assert.equal(task.permission, "allow");
  assert.match(task.user_message, /Fast on Composer 2\.5/);
  const read = runHook("cco-tool-gate.mjs", { hook_event_name: "preToolUse", conversation_id: "ide-A", model: "default", tool_name: "Read", tool_input: {}, workspace_roots: [ws] });
  assert.equal(read.permission, "allow");
  assert.match(read.agent_message, /relaying the subagent's final message verbatim/);

  // Cheap chat model: a FAST delegation is pointless, the guard keeps the work in the chat.
  runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "ide-B", model: "composer-2.5", prompt: "add a helper", workspace_roots: [ws] });
  const cheapTask = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "ide-B", model: "composer-2.5", tool_name: "Task", tool_input: { description: "helper", prompt: "CCO-SCORES: complexity=2 risk=0 breadth=0 uncertainty=0 latency=2\nadd a helper", subagent_type: "fast-tier" }, workspace_roots: [ws] });
  assert.equal(cheapTask.permission, "deny");
  assert.match(cheapTask.agent_message, /directly in this chat/);
  const cheapDeep = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "ide-B", model: "composer-2.5", tool_name: "Task", tool_input: { description: "rotate", prompt: "CCO-SCORES: complexity=3 risk=9 breadth=1 uncertainty=0 latency=0\nrotate production secrets", subagent_type: "deep-tier" }, workspace_roots: [ws] });
  assert.equal(cheapDeep.permission, "allow", "quality escalation is always allowed");
  const cheapBalanced = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "ide-B", model: "composer-2.5", tool_name: "Task", tool_input: { description: "refactor", prompt: "CCO-SCORES: complexity=6 risk=3 breadth=4 uncertainty=2 latency=0\nrefactor the cart module", subagent_type: "balanced-tier" }, workspace_roots: [ws] });
  assert.equal(cheapBalanced.permission, "allow", "moving up to a stronger model is the parent's quality call");
});

test("step-level delegation: same-model deep task keeps edits in chat but sends research to fast-research after the read budget", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fast-research-"));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5", "fast-research": "composer-2.5" });
  createSession({ workspace: ws, conversationId: "conv-X", model: "claude-opus-5-thinking-high" });
  runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "conv-X", model: "claude-opus-5-thinking-high", prompt: "Rotate the production OAuth secret and payment webhook signing key across the services, delete the legacy keys, with a rollback path and tests", workspace_roots: [ws] });
  const read = { hook_event_name: "preToolUse", conversation_id: "conv-X", model: "claude-opus-5-thinking-high", tool_name: "Read", tool_input: { file_path: "a" }, workspace_roots: [ws] };
  assert.equal(runHook("cco-tool-gate.mjs", read).permission, "allow", "read 1 within budget (deep stays in chat)");
  assert.equal(runHook("cco-tool-gate.mjs", read).permission, "allow", "read 2");
  assert.equal(runHook("cco-tool-gate.mjs", read).permission, "allow", "read 3");
  const fourth = runHook("cco-tool-gate.mjs", read);
  assert.equal(fourth.permission, "allow", "advise-first: read allowed with explore advice attached");
  assert.match(fourth.agent_message, /subagent_type="composer-2\.5-research"/);
  const explore = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-X", model: "claude-opus-5-thinking-high", tool_name: "Task", tool_input: { description: "find usages", prompt: "Where is the webhook key validated?", subagent_type: "fast-research" }, workspace_roots: [ws] });
  assert.equal(explore.permission, "allow");
  assert.match(explore.user_message, /Research on Composer 2\.5/);
  const write = runHook("cco-tool-gate.mjs", { ...read, tool_name: "Write" });
  assert.equal(write.permission, "allow", "after research the deep work still happens in the chat (same model), not relay-only");
  assert.equal(loadSession(ws, "conv-X").denials || 0, 0, "the research nudge never counts toward the escape hatch");
  const readAfter = runHook("cco-tool-gate.mjs", read);
  assert.equal(readAfter.permission, "allow", "reads allowed again once research was delegated");
});

test("task guard appends the project's acceptance test command and a cost estimate", async () => {
  const { detectTestCommand, estimateTaskCostUsd } = await import("../scripts/lib/project.mjs");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-accept-"));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5", "fast-research": "composer-2.5" });
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
  assert.equal(detectTestCommand(ws).command, "npm test");
  assert.equal(detectTestCommand(fs.mkdtempSync(path.join(os.tmpdir(), "cco-empty-"))), null);
  const out = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-T", model: "claude-opus-5-thinking-high", tool_name: "Task", tool_input: { description: "helper", prompt: "CCO-SCORES: complexity=3 risk=0 breadth=1 uncertainty=0 latency=0\nadd a helper", subagent_type: "fast-tier" }, workspace_roots: [ws] });
  assert.equal(out.permission, "allow");
  assert.match(out.updated_input.prompt, /Acceptance: after your changes run `npm test`/);
  assert.match(out.user_message, /(~\$0\.\d+|<\$0\.01)/);
  assert.ok(estimateTaskCostUsd({ tier: "deep", model: "claude-opus-5-thinking-high", pricing, config }) > estimateTaskCostUsd({ tier: "fast", model: "composer-2.5", pricing, config }));
});

test("post-tool hook runs the acceptance test after FAST edits and reports CCO-VERIFY", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-verify-"));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "inherit", "deep-tier": "inherit", "tier-verifier": "inherit", "fast-research": "inherit" });
  fs.mkdirSync(path.join(ws, "test"), { recursive: true });
  fs.writeFileSync(path.join(ws, "test", "ok.test.mjs"), 'import test from "node:test"; test("ok", () => {});');
  const pass = runHook("cco-task-result.mjs", { hook_event_name: "postToolUse", tool_name: "Task", tool_input: { subagent_type: "fast-tier" }, tool_output: "Created utils/x.js and updated test/ok.test.mjs", workspace_roots: [ws] });
  assert.match(pass.additional_context, /CCO-VERIFY: pass/);
  fs.writeFileSync(path.join(ws, "test", "bad.test.mjs"), 'import test from "node:test"; import assert from "node:assert"; test("bad", () => assert.equal(1, 2));');
  const fail = runHook("cco-task-result.mjs", { hook_event_name: "postToolUse", tool_name: "Task", tool_input: { subagent_type: "fast-tier" }, tool_output: "Updated utils/x.js", workspace_roots: [ws] });
  assert.match(fail.additional_context, /CCO-VERIFY: fail/);
  assert.match(fail.additional_context, /delegate once to (balanced-tier|[a-z0-9.-]+-balanced)/i);
});

test("built-in explore delegations are rewritten to fast-research and count as research", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-builtin-"));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "inherit", "deep-tier": "inherit", "tier-verifier": "inherit", "fast-research": "composer-2.5" });
  createSession({ workspace: ws, conversationId: "conv-B2", model: "claude-opus-5-thinking-high" });
  const out = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-B2", model: "claude-opus-5-thinking-high", tool_name: "Task", tool_input: { description: "find parser", prompt: "Where are override tokens parsed?", subagent_type: "explore" }, workspace_roots: [ws] });
  assert.equal(out.permission, "allow");
  assert.equal(out.updated_input.subagent_type, "fast-research");
  assert.match(out.user_message, /Research on Composer 2\.5/);
  assert.equal(loadSession(ws, "conv-B2").research.length, 1);
});

test("routed tasks: the card line carries the numbers and the model is told not to write its own cost line; in-chat work gets no message", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-footer-"));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5", "fast-research": "composer-2.5" });
  createSession({ workspace: ws, conversationId: "conv-F", model: "claude-opus-5-thinking-high" });
  const routed = runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-F", model: "claude-opus-5-thinking-high", tool_name: "Task", tool_input: { description: "helper", prompt: "CCO-SCORES: complexity=3 risk=0 breadth=1 uncertainty=0 latency=0\nadd a helper", subagent_type: "fast-tier" }, workspace_roots: [ws] });
  assert.match(routed.agent_message, /Do not add a Cost Optimizer line/);
  assert.match(routed.user_message, /saves /);
  const decisions = fs.readFileSync(workspacePaths(ws).decisionsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(decisions[0].multiplier < 1 && decisions[0].estimateUsd < decisions[0].chatEstimateUsd);

  createSession({ workspace: ws, conversationId: "conv-G", model: "claude-opus-5-thinking-high" });
  runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "conv-G", model: "claude-opus-5-thinking-high", prompt: "Rotate the production OAuth secret and payment webhook signing key across the services, delete the legacy keys, with a rollback path and tests", workspace_roots: [ws] });
  const first = runHook("cco-tool-gate.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-G", model: "claude-opus-5-thinking-high", tool_name: "Write", tool_input: {}, workspace_roots: [ws] });
  assert.equal(first.permission, "allow");
  assert.equal(first.permission, "allow");
  const second = runHook("cco-tool-gate.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-G", model: "claude-opus-5-thinking-high", tool_name: "Write", tool_input: {}, workspace_roots: [ws] });
  assert.equal(second.agent_message, undefined, "nothing to say for work that rightly stays in chat");
});

test("per-chat budget warns at 80% and, when enforced, forces FAST beyond 2x", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-budget-"));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5", "fast-research": "composer-2.5" });
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "cco.json"), JSON.stringify({ budget: { sessionUsd: 0.5, warnAtFraction: 0.8, enforce: true } }));
  createSession({ workspace: ws, conversationId: "conv-B", model: "composer-2.5" });
  const task = () => runHook("cco-task-guard.mjs", { hook_event_name: "preToolUse", conversation_id: "conv-B", model: "composer-2.5", tool_name: "Task", tool_input: { description: "d", prompt: "CCO-SCORES: complexity=6 risk=3 breadth=3 uncertainty=2 latency=0\nrefactor", subagent_type: "balanced-tier" }, workspace_roots: [ws] });
  const a = task();
  assert.equal(a.permission, "allow");
  assert.match(a.user_message, /Balanced on Claude Sonnet 5/);
  assert.equal(a.updated_input, undefined, "nothing rewritten while under budget");
  let last = a;
  for (let i = 0; i < 9; i += 1) { last = task(); }
  assert.match(last.user_message, /budget: /);
  assert.equal(last.updated_input.subagent_type, "composer-2.5-fast", "forced to FAST beyond 2x budget");
});

test("research nudge is issued once per turn and does not open the escape hatch for risky work on a cheap chat model", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-nudge-"));
  writeWorkspaceAgents(ws, { "fast-tier": "composer-2.5", "balanced-tier": "claude-sonnet-5-thinking-high", "deep-tier": "claude-opus-5-thinking-high", "tier-verifier": "composer-2.5", "fast-research": "composer-2.5" });
  createSession({ workspace: ws, conversationId: "conv-N", model: "claude-sonnet-5-thinking-high" });
  runHook("cco-prompt-capture.mjs", { hook_event_name: "beforeSubmitPrompt", conversation_id: "conv-N", model: "claude-sonnet-5-thinking-high", prompt: "Rotate the production OAuth secret and payment webhook signing key across the services, delete the legacy keys, with a rollback path and tests", workspace_roots: [ws] });
  const read = { hook_event_name: "preToolUse", conversation_id: "conv-N", model: "claude-sonnet-5-thinking-high", tool_name: "Read", tool_input: {}, workspace_roots: [ws] };
  for (let i = 0; i < 3; i += 1) { assert.equal(runHook("cco-tool-gate.mjs", read).permission, "allow"); }
  const nudge = runHook("cco-tool-gate.mjs", read);
  assert.equal(nudge.permission, "allow");
  assert.match(nudge.agent_message, /-research/);
  assert.equal(runHook("cco-tool-gate.mjs", read).agent_message, undefined, "nudged once, then reads continue silently");
  const write = runHook("cco-tool-gate.mjs", { ...read, tool_name: "Write" });
  assert.equal(write.permission, "deny", "quality escalation is enforced even in advise mode");
  assert.match(write.agent_message, /subagent_type="claude-opus-5-deep"/, "risky work on a non-deep chat model goes to the deep subagent");
  assert.equal(loadSession(ws, "conv-N").denials, 1, "only the quality denial counts");
});

test("tiny one-file edits stay in the chat even in router mode; new CLI turns reset relay-only state", async () => {
  const { isTinyTask, isQuestionLike } = await import("../scripts/lib/scorer.mjs");
  assert.equal(isTinyTask("fix the typo in README.md"), true);
  assert.equal(isTinyTask("rename foo to bar in utils/x.js"), true);
  assert.equal(isTinyTask("Create utils/slugify.js and a test for it"), false);
  assert.equal(isQuestionLike("fix the typo in README.md"), false);
  const tiny = gateDecision({ toolName: "Edit", session: session(), config, pricing, models, prompt: "fix the typo in README.md" });
  assert.equal(tiny.reason, "tiny_task_stays_in_chat");

  const { syncTurnFromTranscript, userPromptFromTranscriptTurn } = await import("../scripts/lib/session.mjs");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-turns-"));
  const transcript = path.join(ws, "t.jsonl");
  const userLine = (q) => JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `<user_query>\n${q}\n</user_query>` }] } });
  fs.writeFileSync(transcript, `${userLine("first task")}\n`);
  const sess = { delegations: [{ agent: "fast-tier" }], denials: 2, readCount: 5 };
  assert.equal(syncTurnFromTranscript(sess, transcript), false, "first observation just records the turn count");
  fs.appendFileSync(transcript, `${userLine("second task")}\n`);
  assert.equal(syncTurnFromTranscript(sess, transcript), true);
  assert.deepEqual(sess.delegations, []);
  assert.equal(sess.denials, 0);
  assert.equal(userPromptFromTranscriptTurn(transcript, -1), "second task");
});
