import fs from "node:fs";
import path from "node:path";

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function firstWorkspaceRoot(payload) {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && roots.length > 0 && typeof roots[0] === "string") return roots[0];
  return null;
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function appendJsonl(filePath, obj) {
  try { fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8"); } catch {}
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const payload = safeJsonParse(stdin.trim() || "{}");
  const cmdRaw = String(payload.command ?? payload.shellCommand ?? payload.text ?? "").trim();

  // Normalize for checks
  const cmd = cmdRaw.toLowerCase();

  // Allow common safe cleanup patterns explicitly
  const explicitlyAllowed = [
    /^rm\s+-rf\s+node_modules(\s|$)/,
    /^rm\s+-rf\s+dist(\s|$)/,
    /^rm\s+-rf\s+build(\s|$)/,
    /^rm\s+-rf\s+\.next(\s|$)/,
    /^rm\s+-rf\s+\.turbo(\s|$)/
  ];
  if (explicitlyAllowed.some((re) => re.test(cmd))) {
    const out = { continue: true, permission: "allow" };
    console.log(JSON.stringify(out));
    return;
  }

  // Block clearly destructive patterns (conservative)
  const blocked = [
    /rm\s+-rf\s+\/(\s|$)/,          // rm -rf /
    /rm\s+-rf\s+~(\s|$)/,           // rm -rf ~
    /\bmkfs\b/,                     // format disk
    /\bdd\s+if=/,                   // raw disk write often
    /\bshutdown\b|\breboot\b/,      // power ops
    /\bcurl\b.*\|\s*sh\b/,          // curl | sh
    /\bwget\b.*\|\s*sh\b/           // wget | sh
  ];

  const isBlocked = blocked.some((re) => re.test(cmd));
  const workspace = firstWorkspaceRoot(payload) ?? process.cwd();
  const logDir = path.join(workspace, ".ai", "cco");
  ensureDir(logDir);

  const logPath = path.join(logDir, "hook-shell.jsonl");
  appendJsonl(logPath, {
    ts: new Date().toISOString(),
    event: "beforeShellExecution",
    allowed: !isBlocked,
    command: cmdRaw.slice(0, 500)
  });

  if (isBlocked) {
    const msg = `Blocked potentially destructive shell command.\nCommand: ${cmdRaw}\nIf you intended this, run it manually outside the agent.`;
    const out = {
      continue: false,
      permission: "deny",
      // support both snake_case and camelCase keys (Cursor versions differ)
      user_message: msg,
      agent_message: msg,
      userMessage: msg,
      agentMessage: msg
    };
    console.log(JSON.stringify(out));
    return;
  }

  console.log(JSON.stringify({ continue: true, permission: "allow" }));
});
