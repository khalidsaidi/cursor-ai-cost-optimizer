"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

const { runHookCommand } = require("../../dist/selfcheck.js");
const ROOT = path.resolve(__dirname, "..", "..");
const q = (p) => `"${p}"`;

test("self-check: a healthy hook answers JSON quickly", async () => {
  const cmd = `node ${q(path.join(ROOT, "resources", "plugin", "scripts", "cco-hook.mjs"))} preToolUse`;
  const r = await runHookCommand(cmd, os.tmpdir(), { hook_event_name: "preToolUse", tool_name: "Read", conversation_id: "sc", tool_input: {}, workspace_roots: [os.tmpdir()] });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.ms < 6000);
});

test("self-check: a command that cannot spawn fails fast; a hanging one is cut off at the timeout", async () => {
  const bad = await runHookCommand(`${q(path.join(os.tmpdir(), "no-such-cco-hook"))} preToolUse`, os.tmpdir(), {});
  assert.equal(bad.ok, false);
  const hang = await runHookCommand(`node -e "setTimeout(() => {}, 30000)"`, os.tmpdir(), {}, 1500);
  assert.equal(hang.ok, false);
  assert.match(String(hang.error), /no answer within 1500 ms/);
  assert.ok(hang.ms < 4000);
});
