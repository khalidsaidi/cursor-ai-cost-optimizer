const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseHooksLog, findWindowHooksLog, hooksLoadedInWindow } = require("../../dist/hooksLog.js");

const LOADED = `[2026-09-04T22:17:00.673Z] Reloading hooks configuration...
[2026-09-04T22:17:00.673Z] Claude Code hooks disabled (thirdPartyExtensibilityEnabled off)
[2026-09-04T22:17:00.685Z] No enterprise hooks configuration found
[2026-09-04T22:17:00.700Z] Loaded 8 user hook(s) for steps: sessionStart, beforeSubmitPrompt, preToolUse
[2026-09-04T22:17:00.707Z] ERROR: Failed to parse project hooks configuration
[2026-09-04T22:17:00.707Z] No project hooks configuration found
`;

test("hooks log: loaded user hooks are recognised; Cursor's unrelated 'Claude Code hooks disabled' line is ignored", () => {
  const r = parseHooksLog(LOADED);
  assert.equal(r.known, true);
  assert.equal(r.loaded, true);
  assert.equal(r.userHooks, 8);
});

test("hooks log: zero hooks after a reload, or a disabled/policy line, means Cursor is not running them", () => {
  const none = parseHooksLog(LOADED + "[2026-09-04T22:20:00.000Z] Reloading hooks configuration...\n[2026-09-04T22:20:00.001Z] Loaded 0 user hook(s) for steps: \n");
  assert.equal(none.known, true);
  assert.equal(none.loaded, false);
  const policy = parseHooksLog("[t] Reloading hooks configuration...\n[t] Hooks are disabled by your team policy\n");
  assert.equal(policy.loaded, false);
  assert.match(policy.reason, /team policy/);
  assert.equal(parseHooksLog("nothing relevant\n").known, false);
});

test("hooks log: the current window's newest real-workspace log is found from the extension's log folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cco-hlog-"));
  const win = path.join(root, "window1");
  const ext = path.join(win, "exthost", "khalidsaidi.cursor-ai-cost-optimizer");
  fs.mkdirSync(ext, { recursive: true });
  fs.mkdirSync(path.join(win, "output_1"), { recursive: true });
  fs.writeFileSync(path.join(win, "output_1", "cursor.hooks.workspaceId-empty-window.log"), "Loaded 0 user hook(s)\n");
  fs.writeFileSync(path.join(win, "output_1", "cursor.hooks.workspaceId-abc.log"), LOADED);
  assert.equal(path.basename(findWindowHooksLog(ext)), "cursor.hooks.workspaceId-abc.log");
  assert.equal(hooksLoadedInWindow(ext).loaded, true);
  assert.equal(hooksLoadedInWindow(path.join(root, "nowhere", "x")).known, false);
});
