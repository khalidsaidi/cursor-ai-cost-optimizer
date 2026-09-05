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

test("plugin copies next to the extension: a local copy is retired (moved under the state root), a marketplace one is reported", () => {
  const { findPluginCopies, retirePluginCopies } = require("../../dist/userScope.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cco-home-"));
  const local = path.join(home, ".cursor", "plugins", "local", "cursor-ai-cost-optimizer");
  fs.mkdirSync(path.join(local, ".cursor-plugin"), { recursive: true });
  fs.writeFileSync(path.join(local, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "cursor-ai-cost-optimizer", version: "0.2.0" }));
  const other = path.join(home, ".cursor", "plugins", "local", "someone-else");
  fs.mkdirSync(path.join(other, ".cursor-plugin"), { recursive: true });
  fs.writeFileSync(path.join(other, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "someone-else" }));
  const market = path.join(home, ".cursor", "plugins", "cache", "cursor-public", "cursor-ai-cost-optimizer");
  fs.mkdirSync(path.join(market, "agents"), { recursive: true });
  fs.mkdirSync(path.join(market, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(market, "agents", "cco-fast.md"), "---\nname: cco-fast\n---\n");
  fs.writeFileSync(path.join(market, "hooks", "hooks.json"), "{}");
  const copies = findPluginCopies(home);
  assert.deepEqual(copies.map((c) => [c.kind, c.version]).sort(), [["local", "0.2.0"], ["marketplace", null]]);
  const stateRoot = path.join(home, "state");
  const r = retirePluginCopies(stateRoot, copies);
  assert.deepEqual(r.retired, [local]);
  assert.deepEqual(r.marketplace, [market]);
  assert.equal(fs.existsSync(local), false);
  assert.equal(fs.readdirSync(path.join(stateRoot, "retired-plugins")).length, 1);
  assert.equal(findPluginCopies(home).length, 1, "only the marketplace copy is left");
  fs.rmSync(home, { recursive: true, force: true });
});

test("remote window: subagents written after it opened are recorded as unknown to it (first setup) or as the previous names (re-map)", () => {
  const { recordAgentsWrittenAfterOpen } = require("../../dist/userScope.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cco-win-"));
  const started = Date.now() - 1000;
  assert.equal(recordAgentsWrittenAfterOpen(root, [], started, false).written, false, "a local window refreshes its list itself");
  const first = recordAgentsWrittenAfterOpen(root, [], started, true);
  assert.deepEqual(first, { written: true, noneOfOurs: true });
  let rec = JSON.parse(fs.readFileSync(path.join(root, "window-agents.json"), "utf8"));
  assert.equal(rec.noneOfOurs, true);
  const remap = recordAgentsWrittenAfterOpen(root, ["composer-2.5-fast", "claude-opus-5-deep"], started, true);
  assert.deepEqual(remap, { written: true, noneOfOurs: false });
  rec = JSON.parse(fs.readFileSync(path.join(root, "window-agents.json"), "utf8"));
  assert.deepEqual(rec.names, ["claude-opus-5-deep", "composer-2.5-fast"]);
  // a window that opened with the files in place recorded its own list: left alone
  fs.writeFileSync(path.join(root, "window-agents.json"), JSON.stringify({ ts: new Date().toISOString(), source: "workspaceOpen", names: ["composer-2.5-fast"], noneOfOurs: false }));
  assert.equal(recordAgentsWrittenAfterOpen(root, [], started, true).written, false);
  fs.rmSync(root, { recursive: true, force: true });
});
