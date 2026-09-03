// node:test unit tests for the vscode-free project-local install/doctor/uninstall logic (run after `npm run compile`).
// Runs against temporary workspaces with a fake cursor-agent; nothing outside the temp dirs is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  installWorkspace,
  uninstallWorkspace,
  doctorWorkspace,
  plannedFiles,
  workspaceStatus,
  cleanupLegacyWorkspace,
  buildHookEntries,
  mergeHooks,
  stripCcoHooks,
  hookCommandFor,
  isCcoHookCommand,
  decideHookMode,
  findBundledBinary,
  binaryFileName,
  hostTarget,
  workspacePaths,
} = require("../../dist/install.js");

const ROOT = path.resolve(__dirname, "../..");
const PLUGIN = path.join(ROOT, "resources", "plugin");
const REAL_BINARY = path.join(ROOT, "dist-bin", hostTarget(), binaryFileName());
process.env.CCO_CURSOR_AGENT_BIN = require("../fixtures/fake-agent-path.js");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cco-${name}-`));
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const base = (extra = {}) => ({ pluginRoot: PLUGIN, extensionVersion: "0.2.0", hookRuntime: "auto", ...extra });
function fakeBinary(dir, content = "#!/bin/sh\necho '{\"continue\":true}'\n") {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  const p = path.join(dir, "bin", binaryFileName());
  fs.writeFileSync(p, content, "utf8");
  fs.chmodSync(p, 0o755);
  return p;
}
const entriesOf = (ws) => readJson(workspacePaths(ws).hooksPath).hooks;

test("hook command forms and CCO entry detection", async () => {
  assert.equal(hookCommandFor("sessionStart", "node"), "node .cursor/cco-hook.mjs sessionStart");
  assert.equal(hookCommandFor("preToolUse", "binary", "/w/.cursor/cco/bin/cco-hook"), '"/w/.cursor/cco/bin/cco-hook" preToolUse');
  assert.ok(isCcoHookCommand('"C:\\proj\\.cursor\\cco\\bin\\cco-hook.exe" preToolUse'));
  assert.ok(isCcoHookCommand("node .cursor/cco-hook.mjs sessionStart"), "plugin shim form");
  assert.ok(isCcoHookCommand("node .cursor/cco/scripts/cco-tool-gate.mjs"), "pre-release form");
  assert.equal(isCcoHookCommand("goal-guardian-hook"), false);
  assert.equal(decideHookMode(base({ binaryPath: null })), "node");
  assert.throws(() => decideHookMode(base({ hookRuntime: "binary", binaryPath: null })), /no hook binary/);
});

test("buildHookEntries keeps matcher/timeout from the plugin hooks.json; mergeHooks preserves foreign entries", async () => {
  const plugin = readJson(path.join(PLUGIN, "hooks", "hooks.json"));
  const ours = buildHookEntries(plugin, "binary", "/x/cco-hook");
  for (const [event, entries] of Object.entries(plugin.hooks)) {
    assert.equal(ours[event][0].command, `"/x/cco-hook" ${event}`);
    assert.equal(ours[event][0].matcher, entries[0].matcher);
    assert.equal(ours[event][0].timeout, entries[0].timeout);
  }
  const merged = mergeHooks({ version: 1, custom: true, hooks: { preToolUse: [{ command: "other" }, { command: "node .cursor/cco-hook.mjs preToolUse" }], afterFileEdit: [{ command: "gg" }] } }, { preToolUse: ours.preToolUse });
  assert.equal(merged.custom, true);
  assert.deepEqual(merged.hooks.afterFileEdit, [{ command: "gg" }]);
  assert.deepEqual(merged.hooks.preToolUse.map((e) => e.command), ["other", '"/x/cco-hook" preToolUse']);
  assert.equal(stripCcoHooks({ version: 1, hooks: { a: [{ command: '"/x/cco-hook" a' }] } }), null);
});

test("installWorkspace (node runtime): plugin layout + rule, nothing outside .cursor/, no skills/commands copies", async () => {
  const ws = tmp("ws");
  try {
    fs.writeFileSync(path.join(ws, "README.md"), "# fixture\n");
    fs.mkdirSync(path.join(ws, ".cursor"));
    fs.writeFileSync(path.join(ws, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "other-tool-hook" }] } }));
    const plan = plannedFiles(ws, base());
    assert.ok(plan.creates.some((f) => f.startsWith(".cursor/agents/")) && plan.creates.includes(".cursor/rules/cco-routing.mdc") && plan.modifies[0].startsWith(".cursor/hooks.json"));
    assert.equal(plan.creates.some((f) => f.includes("skills") || f.includes("commands")), false);

    const r = await installWorkspace(ws, base());
    assert.equal(r.hookMode, "node");
    assert.equal(r.init.runtime, "node");
    assert.equal(r.init.status, 0, r.init.error);
    const p = workspacePaths(ws);
    for (const rel of ["hooks.json", "cco-hook.mjs", "cco/plugin-path.txt", "cco/runtime.json", "cco/extension-manifest.json", "agents/cco-fast.md", "agents/cco-verifier.md", "rules/cco-routing.mdc"]) {
      assert.ok(fs.existsSync(path.join(p.cursorDir, rel)), `missing .cursor/${rel}`);
    }
    for (const rel of ["skills", "commands"]) {
      assert.equal(fs.existsSync(path.join(p.cursorDir, rel)), false, `.cursor/${rel} must not be created`);
    }
    for (const rel of []) {
      assert.ok(fs.existsSync(path.join(p.cursorDir, rel)), `missing .cursor/${rel}`);
    }
    assert.equal(fs.readFileSync(p.pluginPathFile, "utf8").trim(), PLUGIN, "shim pinned to the bundled plugin");
    assert.deepEqual(fs.readdirSync(ws).sort(), [".cursor", "README.md"], "nothing else in the repo");
    assert.equal(fs.existsSync(path.join(ws, ".cursor", "cco", "bin")), false);
    const hooks = entriesOf(ws);
    assert.deepEqual(hooks.afterFileEdit, [{ command: "other-tool-hook" }]);
    assert.equal(hooks.sessionStart[0].command, "node .cursor/cco-hook.mjs sessionStart");
    assert.equal(hooks.preToolUse[0].matcher, ".*");
    assert.equal(r.agents["cco-fast"], "composer-2.5");
    assert.equal(r.agents["cco-deep"], "claude-opus-5-thinking-high");
    assert.ok(fs.readFileSync(path.join(p.agentsDir, "cco-fast.md"), "utf8").includes("generated by cursor-ai-cost-optimizer"));
    const status = workspaceStatus(ws);
    assert.equal(status.enabled, true);
    assert.equal(status.hookMode, "node");

    // idempotent; user-authored agent never overwritten
    fs.writeFileSync(path.join(p.agentsDir, "cco-fast.md"), "---\nname: cco-fast\nmodel: my-model\n---\nmine\n");
    installWorkspace(ws, base());
    assert.equal(entriesOf(ws).sessionStart.length, 1);
    assert.match(fs.readFileSync(path.join(p.agentsDir, "cco-fast.md"), "utf8"), /model: my-model/);

    const un = await uninstallWorkspace(ws, base());
    assert.equal(un.init.status, 0, un.init.error);
    assert.deepEqual(readJson(p.hooksPath), { version: 1, hooks: { afterFileEdit: [{ command: "other-tool-hook" }] } });
    assert.equal(fs.existsSync(p.ccoDir), false);
    assert.equal(fs.existsSync(p.configPath), false);
    assert.equal(fs.existsSync(path.join(p.rulesDir, "cco-routing.mdc")), false);
    assert.equal(fs.existsSync(p.skillsDir), false);
    assert.equal(fs.existsSync(path.join(p.agentsDir, "cco-deep.md")), false, "generated agent removed");
    assert.ok(fs.existsSync(path.join(p.agentsDir, "cco-fast.md")), "user-authored agent kept");
    assert.equal(workspaceStatus(ws).enabled, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("installWorkspace (binary mode) + doctor: binary at .cursor/cco/bin, quoted absolute commands, repoint/refresh", { skip: process.platform === "win32" && "uses a shell-script stand-in for the binary; the real-binary path is covered by the compiled-binary test" }, async () => {
  const ws = tmp("ws");
  const ext = tmp("ext");
  try {
    const bin = fakeBinary(ext, `#!/bin/sh\n# v1\ncase "$1" in init) shift; exec node "${PLUGIN}/scripts/cco-init.mjs" "$@";; esac\necho '{"continue":true}'\n`);
    assert.equal(findBundledBinary(ext), bin);
    const r = await installWorkspace(ws, base({ binaryPath: bin, hookRuntime: "binary" }));
    const p = workspacePaths(ws);
    assert.equal(r.hookMode, "binary");
    assert.equal(r.binaryPath, p.binaryPath);
    if (process.platform !== "win32") assert.equal(fs.statSync(p.binaryPath).mode & 0o777, 0o755);
    for (const [event, entries] of Object.entries(entriesOf(ws))) {
      assert.equal(entries[0].command, `"${p.binaryPath}" ${event}`);
    }
    assert.equal(entriesOf(ws).postToolUse[0].matcher, "Task");
    assert.ok(fs.existsSync(p.shimPath), "shim still present for node users");
    assert.deepEqual(doctorWorkspace(ws, base({ binaryPath: bin, hookRuntime: "binary" })), { installed: true, changed: false, hookMode: "binary", actions: [] });

    fs.writeFileSync(bin, `#!/bin/sh\n# v2\ncase "$1" in init) shift; exec node "${PLUGIN}/scripts/cco-init.mjs" "$@";; esac\necho '{"continue":true}'\n`);
    assert.deepEqual(doctorWorkspace(ws, base({ binaryPath: bin, hookRuntime: "binary" })).actions, ["binary_refreshed"]);

    // workspace moved: absolute binary path in hooks.json is stale
    const moved = path.join(path.dirname(ws), `${path.basename(ws)}-moved`);
    fs.renameSync(ws, moved);
    try {
      const d = doctorWorkspace(moved, base({ binaryPath: bin }));
      assert.deepEqual(d.actions, ["hooks_repointed"]);
      assert.equal(entriesOf(moved).sessionStart[0].command, `"${workspacePaths(moved).binaryPath}" sessionStart`);
      // extension updated (new path/version): plugin-path repointed, assets refreshed
      const d2 = doctorWorkspace(moved, { ...base({ binaryPath: bin }), pluginRoot: PLUGIN + path.sep, extensionVersion: "0.3.0" });
      assert.ok(d2.actions.includes("plugin_path_repointed") && d2.actions.includes("assets_refreshed"), d2.actions.join(","));
      // hookRuntime=node removes the binary and switches commands back to the shim
      const d3 = doctorWorkspace(moved, { ...base({ binaryPath: bin, hookRuntime: "node" }), pluginRoot: PLUGIN + path.sep, extensionVersion: "0.3.0" });
      assert.deepEqual(d3.actions, ["binary_removed", "hooks_repointed"]);
      assert.equal(entriesOf(moved).sessionStart[0].command, "node .cursor/cco-hook.mjs sessionStart");
      assert.deepEqual(doctorWorkspace(path.join(ext, "nothing"), base()), { installed: false, changed: false, hookMode: null, actions: [] });
    } finally {
      fs.renameSync(moved, ws);
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test("pre-release files under .cursor/cco are cleaned on install", async () => {
  const ws = tmp("ws");
  try {
    fs.mkdirSync(path.join(ws, ".cursor", "cco", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".cursor", "cco", "scripts", "cco-hook.mjs"), "");
    fs.writeFileSync(path.join(ws, ".cursor", "cco-runtime.json"), "{}");
    assert.deepEqual(cleanupLegacyWorkspace(ws), [".cursor/cco/scripts", ".cursor/cco-runtime.json"]);
    assert.deepEqual(cleanupLegacyWorkspace(ws), []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("installWorkspace via the compiled binary (hookRuntime=binary runs cco-init through the binary: no Node needed)", { skip: !fs.existsSync(REAL_BINARY) && `binary not built: ${REAL_BINARY}` }, async () => {
  const ws = tmp("ws");
  try {
    const r = await installWorkspace(ws, base({ binaryPath: REAL_BINARY, hookRuntime: "binary" }));
    assert.equal(r.init.runtime, "binary", r.init.error);
    assert.equal(r.init.status, 0, r.init.error);
    assert.equal(r.hookMode, "binary");
    assert.equal(r.agents["cco-fast"], "composer-2.5");
    assert.ok(fs.existsSync(workspacePaths(ws).shimPath));
    const un = await uninstallWorkspace(ws, base({ binaryPath: REAL_BINARY, hookRuntime: "binary" }));
    assert.equal(un.init.runtime, "binary");
    assert.equal(fs.existsSync(workspacePaths(ws).ccoDir), false);
    assert.ok(un.init.ran);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("Windows hook command quoting (simulated with path.win32)", async () => {
  const bin = path.win32.join("C:\\Users\\me\\proj", ".cursor", "cco", "bin", "cco-hook.exe");
  assert.equal(hookCommandFor("preToolUse", "binary", bin), '"C:\\Users\\me\\proj\\.cursor\\cco\\bin\\cco-hook.exe" preToolUse');
  assert.equal(hookCommandFor("sessionStart", "node"), "node .cursor/cco-hook.mjs sessionStart");
  const plugin = readJson(path.join(PLUGIN, "hooks", "hooks.json"));
  const ours = buildHookEntries(plugin, "binary", bin);
  assert.ok(Object.values(ours).flat().every((e) => isCcoHookCommand(e.command) && e.command.startsWith('"C:\\Users\\me\\proj\\')));
});

test("mergeHooks is idempotent with foreign entries (repeated merges never duplicate or reorder foreign entries)", async () => {
  const plugin = readJson(path.join(PLUGIN, "hooks", "hooks.json"));
  const ours = buildHookEntries(plugin, "node");
  let file = { version: 1, hooks: { preToolUse: [{ command: "foreign-a", matcher: "Write" }], afterFileEdit: [{ command: "foreign-b" }] }, extra: { keep: true } };
  const once = mergeHooks(file, ours);
  const twice = mergeHooks(once, ours);
  const thrice = mergeHooks(JSON.parse(JSON.stringify(twice)), ours);
  assert.deepEqual(twice, once);
  assert.deepEqual(thrice, once);
  assert.deepEqual(once.hooks.preToolUse[0], { command: "foreign-a", matcher: "Write" });
  assert.equal(once.hooks.preToolUse.filter((e) => isCcoHookCommand(e.command)).length, 1);
  assert.deepEqual(once.hooks.afterFileEdit, [{ command: "foreign-b" }]);
  assert.deepEqual(once.extra, { keep: true });
  assert.equal(stripCcoHooks(once).hooks.preToolUse.length, 1);
});
