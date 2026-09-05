import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/** Plugin root (holds config/, agents/, scripts/). Overridable for relocated/bundled installs (e.g. the VS Code extension). */
export const PLUGIN_ROOT = process.env.CCO_PLUGIN_ROOT
  ? path.resolve(process.env.CCO_PLUGIN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TIERS = ["fast", "balanced", "deep"];
export const CCO_AGENT_NAMES = ["cco-fast", "cco-balanced", "cco-deep", "cco-verifier", "cco-explore"];
export const CCO_WORK_AGENTS = ["cco-fast", "cco-balanced", "cco-deep"];

export function nowIso() {
  return new Date().toISOString();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function stripAnsi(input) {
  return String(input ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(raw));
  });
}

export function safeJsonParse(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {}
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Write only when content changed; returns true when written. */
export function writeTextIfChanged(filePath, content) {
  const existing = readTextSafe(filePath);
  if (existing === content) {
    return false;
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

const MAX_JSONL_LINES = 2000;

export function appendJsonl(filePath, payload) {
  try {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    // Keep logs bounded: trim to the newest lines once in a while.
    if (Math.random() < 0.02) {
      const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      if (lines.length > MAX_JSONL_LINES) {
        fs.writeFileSync(filePath, `${lines.slice(-MAX_JSONL_LINES).join("\n")}\n`, "utf8");
      }
    }
  } catch {}
}

export function readJsonl(filePath) {
  const text = readTextSafe(filePath);
  if (!text) {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = safeJsonParse(trimmed, null);
    if (parsed && typeof parsed === "object") {
      out.push(parsed);
    }
  }
  return out;
}

/** Resolve the workspace root from a hook payload, falling back to cwd. */
export function workspaceFromPayload(payload) {
  const roots = payload?.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) {
    return roots[0];
  }
  if (process.env.CCO_WORKSPACE) {
    return path.resolve(process.env.CCO_WORKSPACE);
  }
  // Cursor sent the roots and there are none (empty window): nothing to route for.
  if (Array.isArray(roots)) {
    return null;
  }
  const cwd = process.cwd();
  // User-level hooks run with cwd ~/.cursor; that is never a workspace either.
  if (cwd === userCursorDir() || cwd.startsWith(userCursorDir() + path.sep)) {
    return null;
  }
  // When Cursor runs plugin hooks, cwd is the plugin directory; never treat it as a workspace.
  if (cwd.startsWith(PLUGIN_ROOT)) {
    return null;
  }
  if (cwd === os.homedir()) {
    return null;
  }
  return cwd;
}

/**
 * Everything CCO writes lives in the project's .cursor/ folder (Cursor's own convention):
 *   .cursor/hooks.json            hook entries (merge-preserving)
 *   .cursor/cco-hook.mjs          hook shim (committed with hooks.json; a no-op when the plugin is absent)
 *   .cursor/agents/cco-*.md       the four tier subagents (the only place Cursor honors a subagent model)
 *   .cursor/cco.json              your settings for this project (optional; created only when you change a setting)
 *   .cursor/cco/                  shim, runtime mapping, price cache, state and logs (gitignore it if you like)
 */
/** "project" (files under <ws>/.cursor/) or "user" (Cursor's user-level config + a private state root, nothing in the repo). */
export function scope() {
  return process.env.CCO_SCOPE === "user" ? "user" : "project";
}
export function userCursorDir() {
  return path.join(os.homedir(), ".cursor");
}
export function stateRoot() {
  return process.env.CCO_STATE_ROOT ? path.resolve(process.env.CCO_STATE_ROOT) : path.join(userCursorDir(), "cco");
}
export function workspaceSlug(workspace) {
  const hash = crypto.createHash("sha1").update(String(workspace)).digest("hex").slice(0, 10);
  return `${path.basename(workspace).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "ws"}-${hash}`;
}
export function workspacePaths(workspace) {
  const cursorDir = path.join(workspace, ".cursor");
  if (scope() === "user") {
    const root = stateRoot();
    const ccoDir = path.join(root, "workspaces", workspaceSlug(workspace));
    const stateDir = path.join(ccoDir, "state");
    return {
      workspace,
      scope: "user",
      root,
      cursorDir,
      ccoDir,
      agentsDir: path.join(userCursorDir(), "agents"),
      hooksPath: path.join(userCursorDir(), "hooks.json"),
      configPath: path.join(ccoDir, "cco.json"),
      shimPath: null,
      pluginDir: path.join(root, "plugin"),
      runtimePath: path.join(root, "runtime.json"),
      pricingPath: path.join(root, "pricing.json"),
      stateDir,
      sessionsDir: path.join(stateDir, "sessions"),
      dedupeDir: path.join(stateDir, "dedupe"),
      jointStatePath: path.join(stateDir, "joint-state.json"),
      lastPromptPath: path.join(stateDir, "last-prompt.json"),
      decisionsPath: path.join(stateDir, "decisions.jsonl"),
      hooksLogPath: path.join(stateDir, "hooks.jsonl")
    };
  }
  const ccoDir = path.join(cursorDir, "cco");
  const stateDir = path.join(ccoDir, "state");
  return {
    workspace,
    scope: "project",
    root: ccoDir,
    cursorDir,
    ccoDir,
    agentsDir: path.join(cursorDir, "agents"),
    hooksPath: path.join(cursorDir, "hooks.json"),
    configPath: path.join(cursorDir, "cco.json"),
    shimPath: path.join(cursorDir, "cco-hook.mjs"),
    pluginDir: null,
    runtimePath: path.join(ccoDir, "runtime.json"),
    pricingPath: path.join(ccoDir, "pricing.json"),
    stateDir,
    sessionsDir: path.join(stateDir, "sessions"),
    dedupeDir: path.join(stateDir, "dedupe"),
    jointStatePath: path.join(stateDir, "joint-state.json"),
    lastPromptPath: path.join(stateDir, "last-prompt.json"),
    decisionsPath: path.join(stateDir, "decisions.jsonl"),
    hooksLogPath: path.join(stateDir, "hooks.jsonl")
  };
}
export function isEnabled(workspace) {
  if (process.env.CCO_DISABLED && process.env.CCO_DISABLED !== "0") {
    return { enabled: false, reason: "env_disabled" };
  }
  if (!workspace) {
    return { enabled: false, reason: "no_workspace" };
  }
  const paths = workspacePaths(workspace);
  // A project-level setup (files in <ws>/.cursor) takes precedence over the user-level one, like Cursor's own
  // project-over-user rule: the user-scope hooks go inert there so nothing runs twice.
  if (paths.scope === "user" && fs.existsSync(path.join(workspace, ".cursor", "agents", "cco-fast.md")) && fs.existsSync(path.join(workspace, ".cursor", "hooks.json"))) {
    return { enabled: false, reason: "project_scope_active" };
  }
  const cfg = readJsonSafe(paths.configPath);
  if (cfg && cfg.enabled === false) {
    return { enabled: false, reason: "workspace_opt_out" };
  }
  if (!fs.existsSync(path.join(paths.agentsDir, "cco-fast.md"))) {
    return { enabled: false, reason: paths.scope === "user" ? "user_not_set_up" : "workspace_not_set_up" };
  }
  return { enabled: true, reason: null };
}

/** First PATH hit for a command (absolute paths pass through); on Windows also tries .exe/.cmd/.bat. */
export function resolveCommand(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

export function run(cmd, args, options = {}) {
  // Windows: a .cmd/.bat launcher (npm-style shims) cannot be spawned directly by Node 18+; it needs a shell.
  const resolved = process.platform === "win32" ? resolveCommand(cmd) : null;
  if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
    const quoted = [resolved, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a)).join(" ");
    return spawnSync(quoted, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16, shell: true, windowsHide: true, ...options });
  }
  return spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
    ...options
  });
}

export function cursorAgentBinary() {
  return process.env.CCO_CURSOR_AGENT_BIN || "cursor-agent";
}

export function hookLog(paths, record) {
  if (!paths) {
    return;
  }
  appendJsonl(paths.hooksLogPath, { ts: nowIso(), ...record });
}

export function emit(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

export function ageHours(iso) {
  if (!iso) {
    return Number.POSITIVE_INFINITY;
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return Number.POSITIVE_INFINITY;
  }
  return (Date.now() - t) / (1000 * 60 * 60);
}

export function parseArgs(argv, spec = {}) {
  const out = { _: [] };
  for (const [key, def] of Object.entries(spec)) {
    out[key] = def;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name.startsWith("no-")) {
      out[name.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      const asNum = Number(next);
      out[name] = Number.isFinite(asNum) && next.trim() !== "" ? asNum : next;
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
}

/**
 * True when the module at `url` is the script Node was started with. Compares real paths, case-insensitively
 * on Windows (drive-letter case and 8.3 short names differ between argv[1] and import.meta.url there).
 */
export function isMain(url) {
  try {
    const argv1 = process.argv[1] ? fs.realpathSync.native(path.resolve(process.argv[1])) : "";
    const self = fs.realpathSync.native(fileURLToPath(url));
    return process.platform === "win32" ? argv1.toLowerCase() === self.toLowerCase() : argv1 === self;
  } catch {
    return false;
  }
}

/** Hook commands carry the scope on the command line (hooks.json cannot set env). Apply before any path is computed. */
export function applyScopeArgs(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--scope" && argv[i + 1]) process.env.CCO_SCOPE = argv[i + 1];
    if (argv[i] === "--state-root" && argv[i + 1]) process.env.CCO_STATE_ROOT = argv[i + 1];
    if (argv[i] === "--workspace" && argv[i + 1]) process.env.CCO_WORKSPACE = argv[i + 1];
  }
}

/** The scope arguments to hand to a child hook process so it resolves the same state as this one. */
export function scopeArgs() {
  const out = [];
  if (process.env.CCO_SCOPE) out.push("--scope", process.env.CCO_SCOPE);
  if (process.env.CCO_STATE_ROOT) out.push("--state-root", process.env.CCO_STATE_ROOT);
  return out;
}
