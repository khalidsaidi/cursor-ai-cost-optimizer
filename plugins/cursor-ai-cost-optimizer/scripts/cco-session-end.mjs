import fs from "node:fs";
import path from "node:path";

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function appendJsonl(filePath, obj) {
  try { fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8"); } catch {}
}
function firstWorkspaceRoot(payload) {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && roots.length > 0 && typeof roots[0] === "string") return roots[0];
  return null;
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const payload = safeJsonParse(stdin.trim() || "{}");
  const workspace = firstWorkspaceRoot(payload) ?? process.cwd();
  const logDir = path.join(workspace, ".ai", "cco");
  ensureDir(logDir);

  appendJsonl(path.join(logDir, "hook-session.jsonl"), {
    ts: new Date().toISOString(),
    event: "sessionEnd",
    conversation_id: payload.conversation_id ?? null,
    cursor_version: payload.cursor_version ?? null
  });

  console.log(JSON.stringify({ continue: true }));
});
