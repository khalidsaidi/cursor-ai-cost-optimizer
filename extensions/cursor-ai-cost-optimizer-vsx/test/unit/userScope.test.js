"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const PLUGIN = path.join(ROOT, "resources", "plugin");
process.env.CCO_CURSOR_AGENT_BIN = require("../fixtures/fake-agent-path.js");

test("everywhere scope: nothing in the repo, ~/.cursor hooks + agents, pause per project, remove leaves nothing", async () => {
  const { installUser, userStatus, workspacePaused, pauseWorkspace, uninstallUser, doctorUser, userPaths } = require("../../dist/userScope.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cco-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cco-ws-"));
  const stateRoot = path.join(home, "globalStorage", "khalidsaidi.cursor-ai-cost-optimizer", "cco");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fs.writeFileSync(path.join(home, ".cursor-hooks-other.json"), "{}");
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "other-tool" }] } }));
    const opts = { pluginRoot: PLUGIN, binaryPath: null, extensionVersion: "test", hookRuntime: "node" };
    const r = await installUser(opts, stateRoot, ws);
    assert.equal(r.hookMode, "node");
    assert.equal(r.init.status, 0, r.init.error);
    assert.equal(fs.existsSync(path.join(ws, ".cursor")), false, "nothing written into the project");
    const hooks = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "hooks.json"), "utf8"));
    assert.deepEqual(hooks.hooks.afterFileEdit, [{ command: "other-tool" }], "foreign entry kept");
    assert.match(hooks.hooks.preToolUse[0].command, /cco-hook\.mjs" preToolUse --scope user --state-root "/);
    assert.equal(r.agents["fast-tier"], "composer-2.5");
    assert.equal(fs.existsSync(path.join(stateRoot, "plugin", "rules")), false, "the rule is delivered by the sessionStart hook, not the plugin path");
    assert.ok(fs.existsSync(path.join(stateRoot, "plugin", "commands")));
    assert.ok(fs.existsSync(userPaths(stateRoot).manifestPath));
    const s = userStatus(stateRoot);
    assert.equal(s.installed, true);
    assert.equal(workspacePaused(stateRoot, ws), false);
    assert.equal((await pauseWorkspace(opts, stateRoot, ws, true)).status, 0);
    assert.equal(workspacePaused(stateRoot, ws), true);
    assert.equal((await pauseWorkspace(opts, stateRoot, ws, false)).status, 0);
    assert.equal(workspacePaused(stateRoot, ws), false);
    // extension update: plugin path changes -> doctor re-runs the idempotent install
    const d = await doctorUser({ ...opts, extensionVersion: "test2" }, stateRoot);
    assert.deepEqual(d, { installed: true, changed: true, actions: ["repointed_after_update"] });
    assert.equal((await doctorUser({ ...opts, extensionVersion: "test2" }, stateRoot)).changed, false);
    const un = await uninstallUser(opts, stateRoot);
    assert.equal(un.init.status, 0, un.init.error);
    const after = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "hooks.json"), "utf8"));
    assert.deepEqual(after.hooks, { afterFileEdit: [{ command: "other-tool" }] }, "only the foreign entry remains");
    assert.equal(fs.existsSync(path.join(home, ".cursor", "agents", "fast-tier.md")), false);
    assert.equal(fs.existsSync(stateRoot), false, "state root removed");
    assert.equal(userStatus(stateRoot).installed, false);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
