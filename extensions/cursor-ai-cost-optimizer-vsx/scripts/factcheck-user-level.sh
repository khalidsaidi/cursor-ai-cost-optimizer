#!/usr/bin/env bash
# IDE fact-check (single run): does the Cursor IDE load a subagent from ~/.cursor/agents/<name>.md
# (with its model: line) and a rule from ~/.cursor/rules/*.mdc? Nothing is written into the fixture
# workspace; two temporary user-level files are created and removed afterwards. Existing
# ~/.cursor/hooks.json / ~/.cursor/cco are left untouched (their hooks log the Task call for us).
# Keystrokes are sent only after the new Cursor window is verified to be the foreground window.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$ROOT_DIR/test-fixtures/workspace"
RUN_ID="$(date +%s)"
EVIDENCE_DIR="$ROOT_DIR/.ai/ide-factcheck/$RUN_ID"
FRAMES_DIR="$EVIDENCE_DIR/frames"
mkdir -p "$FRAMES_DIR"
BOOT_WAIT="${CCO_IDE_BOOT_WAIT_SECONDS:-35}"
MAX_WAIT="${CCO_IDE_MAX_WAIT_SECONDS:-180}"
AGENT_MODEL="${CCO_FACTCHECK_MODEL:-composer-2.5}"
AGENT_FILE="$HOME/.cursor/agents/cco-factcheck.md"
RULE_FILE="$HOME/.cursor/rules/cco-factcheck.mdc"
RULES_DIR_EXISTED=1; [[ -d "$HOME/.cursor/rules" ]] || RULES_DIR_EXISTED=0
AGENTS_DIR_EXISTED=1; [[ -d "$HOME/.cursor/agents" ]] || AGENTS_DIR_EXISTED=0

cleanup() {
  rm -f "$AGENT_FILE" "$RULE_FILE"
  [[ "$RULES_DIR_EXISTED" == 0 ]] && rmdir "$HOME/.cursor/rules" 2>/dev/null || true
  [[ "$AGENTS_DIR_EXISTED" == 0 ]] && rmdir "$HOME/.cursor/agents" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> [1/5] Writing temporary user-level rule + agent (model: $AGENT_MODEL); clearing fixture .cursor/"
mkdir -p "$HOME/.cursor/agents" "$HOME/.cursor/rules"
cat > "$AGENT_FILE" <<AGENT
---
name: cco-factcheck
description: Fact-check subagent for the CCO extension. Use when asked to delegate to cco-factcheck.
model: $AGENT_MODEL
---

Reply with exactly this single line and nothing else:
FACTCHECK-AGENT-OK
AGENT
cat > "$RULE_FILE" <<'RULE'
---
description: CCO extension fact-check rule (temporary)
alwaysApply: true
---

Begin every reply with the exact token FACTCHECK-RULE-OK on its own line.
RULE
rm -rf "$FIXTURE/.cursor" "$FIXTURE/.ai" "$FIXTURE/utils"
cp "$AGENT_FILE" "$EVIDENCE_DIR/cco-factcheck.md"; cp "$RULE_FILE" "$EVIDENCE_DIR/cco-factcheck.mdc"

capture_frame() {
  local frame_path="$FRAMES_DIR/frame-$(printf '%04d' "$1").png"
  local frame_win; frame_win="$(wslpath -w "$frame_path" | tr -d '\r')"
  powershell.exe -NoProfile -Command "& { param([string]\$out); Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; \$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \$bmp=New-Object System.Drawing.Bitmap \$bounds.Width,\$bounds.Height; \$g=[System.Drawing.Graphics]::FromImage(\$bmp); \$g.CopyFromScreen(\$bounds.Location,[System.Drawing.Point]::Empty,\$bounds.Size); \$bmp.Save(\$out,[System.Drawing.Imaging.ImageFormat]::Png); \$g.Dispose(); \$bmp.Dispose() }" "$frame_win" >/dev/null 2>&1 || true
}

PROMPT="Use the Task tool to delegate to the subagent named cco-factcheck with the prompt: go. Then relay its exact reply verbatim. Do nothing else."
PROMPT_FILE="$EVIDENCE_DIR/prompt.txt"; printf '%s' "$PROMPT" > "$PROMPT_FILE"
PROMPT_FILE_WIN="$(wslpath -w "$PROMPT_FILE" | tr -d '\r')"
LAUNCH_PS="$(mktemp /tmp/cco-factcheck-launch-XXXX.ps1)"
TEARDOWN_PS="$(mktemp /tmp/cco-factcheck-teardown-XXXX.ps1)"
FIXTURE_REMOTE="vscode-remote://wsl+Ubuntu$FIXTURE"
LAUNCHED_AT="$(date +%s)"

cat > "$LAUNCH_PS" <<'PS'
param([string]$PromptFile, [int]$BootWait, [string]$WorkspaceUri, [string]$RunId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$cursorExe = 'C:\Users\khali\AppData\Local\Programs\cursor\Cursor.exe'
$cursorCli = 'C:\Users\khali\AppData\Local\Programs\cursor\resources\app\out\cli.js'
$src = 'C:\Users\khali\AppData\Roaming\Cursor'
$ud = 'C:\Users\khali\AppData\Local\Temp\cursor-factcheck-' + $RunId
New-Item -ItemType Directory -Path $ud -Force | Out-Null
$skip = @('code.lock', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'logs')
Get-ChildItem -Path $src -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination (Join-Path $ud $_.Name) -Recurse -Force -ErrorAction SilentlyContinue
}
$args = @($cursorCli, '--verbose', "--user-data-dir=$ud", "--folder-uri=$WorkspaceUri", '--remote=wsl+Ubuntu', '--new-window')
$p = Start-Process -FilePath $cursorExe -ArgumentList $args -PassThru
Start-Sleep -Seconds $BootWait

# Verify the foreground window belongs to THIS launch (its process command line carries our user-data-dir).
$wshell = New-Object -ComObject WScript.Shell
$null = $wshell.AppActivate('Cursor')
Start-Sleep -Milliseconds 800
$h = [Win32]::GetForegroundWindow(); $fpid = 0; [void][Win32]::GetWindowThreadProcessId($h, [ref]$fpid)
$sb = New-Object System.Text.StringBuilder 512; [void][Win32]::GetWindowText($h, $sb, 512); $title = $sb.ToString()
$fproc = Get-CimInstance Win32_Process -Filter "ProcessId = $fpid" -ErrorAction SilentlyContinue
$ours = ($fproc -and $fproc.CommandLine -and $fproc.CommandLine.Contains($ud))
$sent = $false; $sentAt = $null
if ($ours -and $title -match 'Cursor') {
  $prompt = (Get-Content -Path $PromptFile -Raw).Trim()
  $escaped = [regex]::Replace($prompt, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' })
  $wshell.SendKeys('^l'); Start-Sleep -Seconds 2
  $wshell.SendKeys($escaped); Start-Sleep -Milliseconds 800
  $wshell.SendKeys('{ENTER}'); $sent = $true; $sentAt = (Get-Date).ToUniversalTime().ToString('o')
}
[ordered]@{ pid = $p.Id; userDataDir = $ud; foregroundPid = $fpid; foregroundTitle = $title; foregroundIsOurs = [bool]$ours; sent = $sent; sentAt = $sentAt } | ConvertTo-Json -Compress
PS

cat > "$TEARDOWN_PS" <<'PS'
param([string]$UserDataDir, [int]$CursorPid)
$ErrorActionPreference = 'Continue'
# Stop only the process tree this run started (identified by its unique user-data-dir), never the user's own Cursor.
$mine = Get-CimInstance Win32_Process -Filter "Name = 'Cursor.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($UserDataDir) }
foreach ($m in $mine) { Stop-Process -Id $m.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $CursorPid -Force -ErrorAction SilentlyContinue
[ordered]@{ stopped = @($mine).Count } | ConvertTo-Json -Compress
PS

echo "==> [2/5] Launching Cursor on $FIXTURE_REMOTE (boot wait ${BOOT_WAIT}s); keystrokes only if the new window is foreground"
capture_frame 1
LAUNCH_RAW="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$LAUNCH_PS" -PromptFile "$PROMPT_FILE_WIN" -BootWait "$BOOT_WAIT" -WorkspaceUri "$FIXTURE_REMOTE" -RunId "$RUN_ID" | tr -d '\r' | tail -n 1)"
printf '%s\n' "$LAUNCH_RAW" > "$EVIDENCE_DIR/launch.json"; echo "    $LAUNCH_RAW"
CURSOR_PID="$(node -e 'try{console.log(JSON.parse(process.argv[1]).pid)}catch{console.log("")}' "$LAUNCH_RAW")"
USER_DATA_WIN="$(node -e 'try{console.log(JSON.parse(process.argv[1]).userDataDir)}catch{console.log("")}' "$LAUNCH_RAW")"
SENT="$(node -e 'try{console.log(JSON.parse(process.argv[1]).sent)}catch{console.log(false)}' "$LAUNCH_RAW")"

PROJECT_SLUG="$(echo "$FIXTURE" | sed 's#^/##; s#/#-#g')"
TRANSCRIPTS="$HOME/.cursor/projects/$PROJECT_SLUG/agent-transcripts"
find_transcript() { find "$TRANSCRIPTS" -type f -name '*.jsonl' -newermt "@$LAUNCHED_AT" 2>/dev/null | head -n 1; }

echo "==> [3/5] Waiting up to ${MAX_WAIT}s for the chat turn to end (prompt sent: $SENT)"
waited=0; idx=2; T=""
if [[ "$SENT" == "true" ]]; then
  while (( waited < MAX_WAIT )); do
    capture_frame "$idx"; idx=$((idx + 1))
    T="$(find_transcript)"
    if [[ -n "$T" ]] && grep -q '"turn_ended"' "$T" 2>/dev/null; then sleep 5; waited=$((waited + 5)); break; fi
    sleep 5; waited=$((waited + 5))
  done
fi
capture_frame "$idx"
echo "    transcript: ${T:-none} (waited ${waited}s)"

echo "==> [4/5] Closing this run's Cursor window and collecting evidence"
TEARDOWN_RAW="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TEARDOWN_PS" -UserDataDir "$USER_DATA_WIN" -CursorPid "$CURSOR_PID" | tr -d '\r' | tail -n 1)"
printf '%s\n' "$TEARDOWN_RAW" > "$EVIDENCE_DIR/teardown.json"; rm -f "$LAUNCH_PS" "$TEARDOWN_PS"
[[ -n "$T" && -f "$T" ]] && cp "$T" "$EVIDENCE_DIR/chat-transcript.jsonl"
UD_WSL="$(wslpath -u "$USER_DATA_WIN" 2>/dev/null || true)"
if [[ -n "$UD_WSL" && -d "$UD_WSL/logs" ]]; then
  H="$(find "$UD_WSL/logs" -type f -name 'cursor.hooks.*.log' 2>/dev/null | head -n 1)"; [[ -n "$H" ]] && cp "$H" "$EVIDENCE_DIR/cursor-hooks.log"
fi
FRAME_COUNT="$(find "$FRAMES_DIR" -maxdepth 1 -name 'frame-*.png' | wc -l | tr -d ' ')"
command -v ffmpeg >/dev/null 2>&1 && [[ "$FRAME_COUNT" -gt 1 ]] && ffmpeg -y -loglevel error -framerate 1 -i "$FRAMES_DIR/frame-%04d.png" -vf "format=yuv420p" "$EVIDENCE_DIR/factcheck.mp4" || true

echo "==> [5/5] Evaluating"
EVIDENCE_DIR="$EVIDENCE_DIR" LAUNCH_RAW="$LAUNCH_RAW" AGENT_MODEL="$AGENT_MODEL" WAITED="$waited" node - <<'NODE'
const fs = require("node:fs"); const path = require("node:path"); const env = process.env;
const launch = (() => { try { return JSON.parse(env.LAUNCH_RAW); } catch { return {}; } })();
const tPath = path.join(env.EVIDENCE_DIR, "chat-transcript.jsonl");
const hPath = path.join(env.EVIDENCE_DIR, "cursor-hooks.log");
const texts = []; const toolUses = [];
if (fs.existsSync(tPath)) for (const line of fs.readFileSync(tPath, "utf8").split("\n").filter(Boolean)) {
  let j; try { j = JSON.parse(line); } catch { continue; }
  if (j.role !== "assistant") continue;
  for (const p of Array.isArray(j.message?.content) ? j.message.content : []) {
    if (p.type === "text" && p.text && p.text !== "[REDACTED]") texts.push(p.text);
    if (p.type === "tool_use") toolUses.push({ name: p.name, input: p.input });
  }
}
const hooksLog = fs.existsSync(hPath) ? fs.readFileSync(hPath, "utf8") : "";
const taskInputs = [];
for (const m of hooksLog.matchAll(/INPUT:\n(\{[\s\S]*?\n\})\n\nOUTPUT:/g)) { try { const j = JSON.parse(m[1]); if (j.tool_name === "Task" || j.subagent_type) taskInputs.push({ event: j.hook_event_name, tool_name: j.tool_name, model: j.model, subagent_type: j.subagent_type || j.tool_input?.subagent_type, tool_input_model: j.tool_input?.model }); } catch {} }
const modelsInLog = [...new Set([...hooksLog.matchAll(/"model": "([^"]*)"/g)].map((m) => m[1]))];
const all = texts.join("\n");
const out = {
  generatedAt: new Date().toISOString(),
  launch,
  agentModel: env.AGENT_MODEL,
  promptSent: Boolean(launch.sent),
  transcriptFound: fs.existsSync(tPath),
  cursorHooksLogFound: Boolean(hooksLog),
  waitedSeconds: Number(env.WAITED),
  facts: {
    userRuleApplied: /FACTCHECK-RULE-OK/.test(all),
    userAgentInvokedViaTask: toolUses.some((t) => t.name === "Task" && /cco-factcheck/.test(JSON.stringify(t.input))) || taskInputs.some((t) => t.subagent_type === "cco-factcheck"),
    userAgentReplied: /FACTCHECK-AGENT-OK/.test(all),
  },
  toolUses: toolUses.map((t) => ({ name: t.name, input: JSON.stringify(t.input).slice(0, 300) })),
  taskHookPayloads: taskInputs,
  modelsSeenInHookPayloads: modelsInLog,
  assistantText: texts.map((t) => t.slice(0, 600)),
  evidence: { dir: env.EVIDENCE_DIR, frames: fs.readdirSync(path.join(env.EVIDENCE_DIR, "frames")).length, transcript: fs.existsSync(tPath) ? tPath : null, cursorHooksLog: hooksLog ? hPath : null },
};
fs.writeFileSync(path.join(env.EVIDENCE_DIR, "factcheck.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ promptSent: out.promptSent, facts: out.facts, toolUses: out.toolUses, taskHookPayloads: out.taskHookPayloads, modelsSeenInHookPayloads: modelsInLog, assistantText: out.assistantText, evidenceDir: env.EVIDENCE_DIR }, null, 2));
NODE
echo "Fact-check evidence: $EVIDENCE_DIR/factcheck.json"
