#!/usr/bin/env bash
# Real-IDE proof: launches Cursor desktop (Windows) on the fixture workspace (WSL remote) with the
# CCO assets + hooks installed by this extension's install logic, sends a real chat prompt via
# SendKeys, and asserts ON DISK that the hooks fired and routing happened:
#   .ai/cco/hooks.jsonl      contains a beforeSubmitPrompt event (IDE-only hook) and preToolUse:gate records
#                            for that parent conversation (sessionStart is recorded when the IDE delivers it;
#                            Cursor 3.17 fires workspaceOpen, not a per-chat sessionStart, so it is informational)
#   .ai/cco/decisions.jsonl  contains a cco-* delegation decision
#   utils/slugify.js         was created by the agent
# Cursor's own hooks log (INPUT/OUTPUT of every hook call) and the chat transcript are copied into the
# evidence dir so a failure can be attributed (hook not fired / denied but ignored / model choice).
# It also keeps the original authentication evidence check (Cursor logs show authenticated api2 calls).
# Frames/video are recorded under .ai/ide-proof/<run-id>/ like the UAT runbook.
#
# Env: CCO_IDE_HOOK_MODE=auto|binary|node  CCO_IDE_BOOT_WAIT_SECONDS=35  CCO_IDE_MAX_WAIT_SECONDS=240
#      CCO_IDE_CAPTURE_INTERVAL_SECONDS=5   CCO_KEEP_CURSOR_OPEN=0     CCO_IDE_PROMPT="..."
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$ROOT_DIR/test-fixtures/workspace"
OUT_DIR="$FIXTURE/.cursor/cco/state"
OUT_FILE="$FIXTURE/.ai/cco/ide-auth-proof.json"
RUN_ID="$(date +%s)"
EVIDENCE_DIR="$ROOT_DIR/.ai/ide-proof/$RUN_ID"
FRAMES_DIR="$EVIDENCE_DIR/frames"
VIDEO_MP4="$EVIDENCE_DIR/ide-proof.mp4"
LAUNCH_JSON="$EVIDENCE_DIR/launch.json"
TEARDOWN_JSON="$EVIDENCE_DIR/teardown.json"

KEEP_OPEN="${CCO_KEEP_CURSOR_OPEN:-0}"
HOOK_MODE="${CCO_IDE_HOOK_MODE:-auto}"
BOOT_WAIT="${CCO_IDE_BOOT_WAIT_SECONDS:-35}"
MAX_WAIT="${CCO_IDE_MAX_WAIT_SECONDS:-240}"
POLL_SECONDS="${CCO_IDE_POLL_SECONDS:-5}"
CAPTURE_INTERVAL="${CCO_IDE_CAPTURE_INTERVAL_SECONDS:-5}"
PROMPT="${CCO_IDE_PROMPT:-Create utils/slugify.js exporting slugify(str) (lowercase, spaces to hyphens, strip non-alphanumerics) and utils/slugify.test.mjs using node:test for it, then run node --test utils/ and report the result.}"

mkdir -p "$FRAMES_DIR" "$(dirname "$OUT_FILE")"

if [[ ! -f "$ROOT_DIR/dist/install.js" ]]; then
  (cd "$ROOT_DIR" && npm run compile)
fi

echo "==> [1/6] Installing CCO assets + hooks into fixture workspace ($FIXTURE), hook mode: $HOOK_MODE"
INSTALL_JSON="$(node -e '
const path = require("node:path");
const { installWorkspace, findBundledBinary } = require(path.join(process.argv[1], "dist", "install.js"));
const [root, ws, mode] = process.argv.slice(1);
const bin = mode === "node" ? null : findBundledBinary(root);
if (mode === "binary" && !bin) { console.error("no bundled binary found (run npm run compile:binaries)"); process.exit(1); }
const r = installWorkspace(ws, { pluginRoot: path.join(root, "resources", "plugin"), binaryPath: bin, extensionVersion: "ide-proof", hookRuntime: mode === "node" ? "node" : "auto" });
console.log(JSON.stringify({ hookMode: r.hookMode, binaryPath: r.binaryPath, hookEvents: r.hookEvents, files: r.files.length, agents: r.agents, init: r.init.runtime }));
' "$ROOT_DIR" "$FIXTURE" "$HOOK_MODE")"
echo "    $INSTALL_JSON"

echo "==> [2/6] Resetting routing evidence in the fixture"
rm -rf "$FIXTURE/utils" "$OUT_DIR/hooks.jsonl" "$OUT_DIR/decisions.jsonl" "$OUT_DIR/sessions" "$OUT_DIR/dedupe"
cp "$FIXTURE/.cursor/hooks.json" "$EVIDENCE_DIR/hooks.json.installed"

capture_frame() {
  local idx="$1"
  local frame_path="$FRAMES_DIR/frame-$(printf '%04d' "$idx").png"
  local frame_win
  frame_win="$(wslpath -w "$frame_path" | tr -d '\r')"
  powershell.exe -NoProfile -Command "& { param([string]\$out); Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; \$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \$bmp=New-Object System.Drawing.Bitmap \$bounds.Width,\$bounds.Height; \$g=[System.Drawing.Graphics]::FromImage(\$bmp); \$g.CopyFromScreen(\$bounds.Location,[System.Drawing.Point]::Empty,\$bounds.Size); \$bmp.Save(\$out,[System.Drawing.Imaging.ImageFormat]::Png); \$g.Dispose(); \$bmp.Dispose() }" "$frame_win" >/dev/null 2>&1 || true
}

PROMPT_FILE="$EVIDENCE_DIR/prompt.txt"
printf '%s' "$PROMPT" > "$PROMPT_FILE"
PROMPT_FILE_WIN="$(wslpath -w "$PROMPT_FILE" | tr -d '\r')"
LAUNCH_PS="$(mktemp /tmp/cco-ide-launch-XXXX.ps1)"
TEARDOWN_PS="$(mktemp /tmp/cco-ide-teardown-XXXX.ps1)"
FIXTURE_REMOTE="vscode-remote://wsl+Ubuntu$FIXTURE"

cat > "$LAUNCH_PS" <<'PS'
param([string]$PromptFile, [int]$BootWait, [string]$WorkspaceUri)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$cursorExe = 'C:\Users\khali\AppData\Local\Programs\cursor\Cursor.exe'
$cursorCli = 'C:\Users\khali\AppData\Local\Programs\cursor\resources\app\out\cli.js'
$src = 'C:\Users\khali\AppData\Roaming\Cursor'
$runId = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$ud = 'C:\Users\khali\AppData\Local\Temp\cursor-ide-proof-' + $runId

# Isolated user-data-dir seeded from the real profile (auth/session), never the live one.
New-Item -ItemType Directory -Path $ud -Force | Out-Null
$skip = @('code.lock', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'logs')
Get-ChildItem -Path $src -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination (Join-Path $ud $_.Name) -Recurse -Force -ErrorAction SilentlyContinue
}

$args = @($cursorCli, '--verbose', "--user-data-dir=$ud", "--folder-uri=$WorkspaceUri", '--remote=wsl+Ubuntu', '--new-window')
$p = Start-Process -FilePath $cursorExe -ArgumentList $args -PassThru
Start-Sleep -Seconds $BootWait

$prompt = (Get-Content -Path $PromptFile -Raw).Trim()
# SendKeys treats + ^ % ~ ( ) { } [ ] specially: wrap each in braces.
$escaped = [regex]::Replace($prompt, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' })

$wshell = New-Object -ComObject WScript.Shell
$activated = $wshell.AppActivate('Cursor')
Start-Sleep -Milliseconds 800
$wshell.SendKeys('^l')
Start-Sleep -Seconds 2
$wshell.SendKeys($escaped)
Start-Sleep -Milliseconds 800
$wshell.SendKeys('{ENTER}')
$sentAt = (Get-Date).ToUniversalTime().ToString('o')

[ordered]@{ pid = $p.Id; userDataDir = $ud; activated = [bool]$activated; sentAt = $sentAt; bootWait = $BootWait } | ConvertTo-Json -Compress
PS

cat > "$TEARDOWN_PS" <<'PS'
param([string]$UserDataDir, [int]$CursorPid, [string]$KeepOpen)
$ErrorActionPreference = 'Continue'

function Get-LogMetrics([string]$rootPath) {
  $m = [ordered]@{ latestLogDir = ''; logFileCount = 0; unauthCount = 0; authHeaderCount = 0; cursorApi2OkCount = 0; cursorApi2MentionCount = 0 }
  $latest = Get-ChildItem -Path $rootPath -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { return $m }
  $m.latestLogDir = $latest.FullName
  $files = Get-ChildItem -Path $latest.FullName -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 50000000 }
  $m.logFileCount = ($files | Measure-Object).Count
  foreach ($f in $files) {
    try {
      $txt = Get-Content -Path $f.FullName -Raw -ErrorAction SilentlyContinue
      if ($null -ne $txt) {
        $m.unauthCount += ([regex]::Matches($txt, 'unauthenticated|No authorization header found', 'IgnoreCase')).Count
        $m.authHeaderCount += ([regex]::Matches($txt, 'Authorization":"\*\*\*\*\*"', 'IgnoreCase')).Count
        $m.cursorApi2OkCount += ([regex]::Matches($txt, 'https://api2\.cursor\.sh/\S+ - end \S+ 200', 'IgnoreCase')).Count
        $m.cursorApi2MentionCount += ([regex]::Matches($txt, 'api2\.cursor\.sh', 'IgnoreCase')).Count
      }
    } catch {}
  }
  return $m
}

$m = Get-LogMetrics -rootPath (Join-Path $UserDataDir 'logs')
if ($KeepOpen -ne '1') {
  # Stop only the window this proof started (and its children), never the user's own Cursor.
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $CursorPid" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $CursorPid -Force -ErrorAction SilentlyContinue
}
$m | ConvertTo-Json -Compress
PS

echo "==> [3/6] Launching Cursor desktop on $FIXTURE_REMOTE (boot wait ${BOOT_WAIT}s) and sending the chat prompt"
capture_frame 1
LAUNCH_RAW="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$LAUNCH_PS" -PromptFile "$PROMPT_FILE_WIN" -BootWait "$BOOT_WAIT" -WorkspaceUri "$FIXTURE_REMOTE" | tr -d '\r' | tail -n 1)"
printf '%s\n' "$LAUNCH_RAW" > "$LAUNCH_JSON"
echo "    $LAUNCH_RAW"
CURSOR_PID="$(node -e 'try{console.log(JSON.parse(process.argv[1]).pid)}catch{console.log("")}' "$LAUNCH_RAW")"
USER_DATA_WIN="$(node -e 'try{console.log(JSON.parse(process.argv[1]).userDataDir)}catch{console.log("")}' "$LAUNCH_RAW")"
if [[ -z "$CURSOR_PID" ]]; then
  echo "Cursor did not launch (no pid in launch output)" >&2
  rm -f "$LAUNCH_PS" "$TEARDOWN_PS"
  exit 1
fi

echo "==> [4/6] Waiting up to ${MAX_WAIT}s for on-disk routing evidence (frames every ${CAPTURE_INTERVAL}s)"
has_event() { [[ -f "$OUT_DIR/hooks.jsonl" ]] && grep -Eq "\"event\":\"$1\"" "$OUT_DIR/hooks.jsonl"; }
has_decision() { [[ -f "$OUT_DIR/decisions.jsonl" ]] && grep -Eq '"final":"cco-(fast|balanced|deep)"' "$OUT_DIR/decisions.jsonl"; }
has_gate() { [[ -f "$OUT_DIR/hooks.jsonl" ]] && grep -Eq '"event":"preToolUse:gate"' "$OUT_DIR/hooks.jsonl"; }
waited=0
frame_idx=2
last_capture=0
T_SESSION=""; T_PROMPT=""; T_DECISION=""; T_FILE=""; T_GATE=""
while (( waited < MAX_WAIT )); do
  if (( waited - last_capture >= CAPTURE_INTERVAL )) || (( waited == 0 )); then
    capture_frame "$frame_idx"; frame_idx=$((frame_idx + 1)); last_capture=$waited
  fi
  [[ -z "$T_SESSION" ]] && has_event sessionStart && T_SESSION=$waited
  [[ -z "$T_PROMPT" ]] && has_event beforeSubmitPrompt && T_PROMPT=$waited
  [[ -z "$T_DECISION" ]] && has_decision && T_DECISION=$waited
  [[ -z "$T_GATE" ]] && has_gate && T_GATE=$waited
  [[ -z "$T_FILE" ]] && [[ -f "$FIXTURE/utils/slugify.js" ]] && T_FILE=$waited
  if [[ -n "$T_PROMPT" && -n "$T_GATE" && -n "$T_DECISION" && -n "$T_FILE" ]]; then
    # give the agent a moment to finish the test run before we tear down
    sleep 10; waited=$((waited + 10)); break
  fi
  sleep "$POLL_SECONDS"; waited=$((waited + POLL_SECONDS))
done
capture_frame "$frame_idx"
echo "    sessionStart@${T_SESSION:-never} beforeSubmitPrompt@${T_PROMPT:-never} gate@${T_GATE:-never} decision@${T_DECISION:-never} slugify.js@${T_FILE:-never} (waited ${waited}s)"

echo "==> [5/6] Collecting auth evidence from Cursor logs and closing the proof window (keep open: $KEEP_OPEN)"
TEARDOWN_RAW="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TEARDOWN_PS" -UserDataDir "$USER_DATA_WIN" -CursorPid "$CURSOR_PID" -KeepOpen "$KEEP_OPEN" | tr -d '\r' | tail -n 1)"
printf '%s\n' "$TEARDOWN_RAW" > "$TEARDOWN_JSON"
rm -f "$LAUNCH_PS" "$TEARDOWN_PS"

for f in hooks.jsonl decisions.jsonl; do
  [[ -f "$OUT_DIR/$f" ]] && cp "$OUT_DIR/$f" "$EVIDENCE_DIR/$f"
done
# Cursor's own hooks log (every hook call with INPUT/OUTPUT) from the isolated user-data dir.
USER_DATA_WSL="$(wslpath -u "$USER_DATA_WIN" 2>/dev/null || true)"
CURSOR_HOOKS_LOG=""
if [[ -n "$USER_DATA_WSL" && -d "$USER_DATA_WSL/logs" ]]; then
  CURSOR_HOOKS_LOG="$(find "$USER_DATA_WSL/logs" -type f -name 'cursor.hooks.*.log' 2>/dev/null | head -n 1)"
  [[ -n "$CURSOR_HOOKS_LOG" ]] && cp "$CURSOR_HOOKS_LOG" "$EVIDENCE_DIR/cursor-hooks.log"
fi
# Chat transcript (path is reported in the hook payloads); assistant text = what the user saw in chat.
TRANSCRIPT=""
if [[ -f "$EVIDENCE_DIR/cursor-hooks.log" ]]; then
  TRANSCRIPT="$(grep -aoE '"transcript_path": "[^"]+"' "$EVIDENCE_DIR/cursor-hooks.log" | head -n 1 | sed -E 's/.*: "//; s/"$//')"
fi
if [[ -z "$TRANSCRIPT" && -f "$OUT_DIR/last-prompt.json" ]]; then
  CONV="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).conversation_id||"")}catch{console.log("")}' "$OUT_DIR/last-prompt.json")"
  [[ -n "$CONV" ]] && TRANSCRIPT="$(find "$HOME/.cursor/projects" -type f -path "*agent-transcripts/$CONV/*.jsonl" 2>/dev/null | head -n 1)"
fi
[[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]] && cp "$TRANSCRIPT" "$EVIDENCE_DIR/chat-transcript.jsonl"
[[ -d "$FIXTURE/utils" ]] && cp -r "$FIXTURE/utils" "$EVIDENCE_DIR/utils"
FRAME_COUNT="$(find "$FRAMES_DIR" -maxdepth 1 -name 'frame-*.png' | wc -l | tr -d ' ')"
if command -v ffmpeg >/dev/null 2>&1 && [[ "$FRAME_COUNT" -gt 1 ]]; then
  ffmpeg -y -loglevel error -framerate 1 -i "$FRAMES_DIR/frame-%04d.png" -vf "format=yuv420p" "$VIDEO_MP4" || true
fi

echo "==> [6/6] Writing $OUT_FILE"
INSTALL_JSON="$INSTALL_JSON" LAUNCH_RAW="$LAUNCH_RAW" TEARDOWN_RAW="$TEARDOWN_RAW" OUT_DIR="$OUT_DIR" FIXTURE="$FIXTURE" EVIDENCE_DIR="$EVIDENCE_DIR" VIDEO_MP4="$VIDEO_MP4" FRAME_COUNT="$FRAME_COUNT" WAITED="$waited" T_SESSION="$T_SESSION" T_PROMPT="$T_PROMPT" T_GATE="$T_GATE" T_DECISION="$T_DECISION" T_FILE="$T_FILE" PROMPT="$PROMPT" OUT_FILE="$OUT_FILE" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const env = process.env;
const parse = (s) => { try { return JSON.parse(s || ""); } catch { return null; } };
const jsonl = (p) => { try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const install = parse(env.INSTALL_JSON) || {};
const launch = parse(env.LAUNCH_RAW) || {};
const logs = parse(env.TEARDOWN_RAW) || {};
const hooks = jsonl(path.join(env.OUT_DIR, "hooks.jsonl"));
const decisions = jsonl(path.join(env.OUT_DIR, "decisions.jsonl"));
const events = [...new Set(hooks.map((h) => h.event))];
const delegation = decisions.find((d) => /^cco-(fast|balanced|deep)$/.test(String(d.final || "")));
const promptRecord = hooks.find((h) => h.event === "beforeSubmitPrompt");
const parentConversation = promptRecord?.conversation_id || null;
const gateRecords = hooks.filter((h) => h.event === "preToolUse:gate" && (!parentConversation || h.conversation_id === parentConversation));
const gateDenials = gateRecords.filter((g) => g.action === "deny");
const cursorHooksLogPath = path.join(env.EVIDENCE_DIR, "cursor-hooks.log");
const cursorHooksLog = fs.existsSync(cursorHooksLogPath) ? fs.readFileSync(cursorHooksLogPath, "utf8") : "";
const count = (re) => (cursorHooksLog.match(re) || []).length;
const stepsRequested = {};
for (const m of cursorHooksLog.matchAll(/Hook step requested: ([A-Za-z]+)/g)) stepsRequested[m[1]] = (stepsRequested[m[1]] || 0) + 1;
const cursorHooks = {
  logFound: Boolean(cursorHooksLog),
  stepsRequested,
  sessionStartRequested: stepsRequested.sessionStart || 0,
  executed: count(/Command: "[^"]*cco-hook[^"]*" [A-Za-z]+ \(\d+ms\) exit code: 0/g),
  nonZeroExits: count(/exit code: [1-9]\d*/g),
  denyOutputs: count(/"permission": "deny"/g),
  modelsSeen: [...new Set([...cursorHooksLog.matchAll(/"model": "([^"]*)"/g)].map((m) => m[1]))],
  toolsSeen: [...new Set([...cursorHooksLog.matchAll(/"tool_name": "([^"]*)"/g)].map((m) => m[1]))],
};
const transcriptPath = path.join(env.EVIDENCE_DIR, "chat-transcript.jsonl");
let assistantText = [];
let transcriptToolUses = [];
if (fs.existsSync(transcriptPath)) {
  for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean)) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.role !== "assistant") continue;
    const c = j.message?.content;
    for (const part of Array.isArray(c) ? c : []) {
      if (part.type === "text" && part.text && part.text !== "[REDACTED]") assistantText.push(part.text);
      if (part.type === "tool_use") transcriptToolUses.push(part.name + (part.input?.subagent_type ? `(${part.input.subagent_type})` : ""));
    }
  }
  fs.writeFileSync(path.join(env.EVIDENCE_DIR, "chat-response.txt"), assistantText.join("\n\n---\n\n"), "utf8");
}
const chatRoundTrip = (stepsRequested.beforeSubmitPrompt || 0) > 0 && ((stepsRequested.postToolUse || 0) > 0 || assistantText.length > 0);
const slugify = path.join(env.FIXTURE, "utils", "slugify.js");
const slugifyTest = fs.readdirSync(path.join(env.FIXTURE, "utils")).filter((f) => /test/.test(f)).length > 0 ? true : false;
const routing = {
  hooksSessionStart: hooks.some((h) => h.event === "sessionStart"), // informational: Cursor 3.17 fires workspaceOpen, not per-chat sessionStart
  hooksBeforeSubmitPrompt: Boolean(promptRecord),
  hooksPreToolUseGateForParent: gateRecords.length > 0,
  gateRecords: gateRecords.length,
  gateDenials: gateDenials.length,
  decisionCcoDelegation: Boolean(delegation),
  slugifyCreated: fs.existsSync(slugify),
  slugifyTestCreated: slugifyTest,
};
const auth = {
  latestLogDir: logs.latestLogDir || "",
  logFileCount: Number(logs.logFileCount || 0),
  unauthCount: Number(logs.unauthCount || 0),
  authHeaderCount: Number(logs.authHeaderCount || 0),
  cursorApi2OkCount: Number(logs.cursorApi2OkCount || 0),
  cursorApi2MentionCount: Number(logs.cursorApi2MentionCount || 0),
};
auth.chatRoundTrip = chatRoundTrip;
const authPass = auth.latestLogDir !== "" && auth.logFileCount > 0 && auth.unauthCount === 0 && (auth.authHeaderCount > 0 || auth.cursorApi2OkCount > 0 || (auth.cursorApi2MentionCount > 0 && chatRoundTrip));
const routingPass = routing.hooksBeforeSubmitPrompt && routing.hooksPreToolUseGateForParent && routing.decisionCcoDelegation && routing.slugifyCreated;
const out = {
  generatedAt: new Date().toISOString(),
  pass: authPass && routingPass,
  authPass,
  routingPass,
  install,
  launch,
  prompt: env.PROMPT,
  timeline: { waitedSeconds: Number(env.WAITED), sessionStartAt: env.T_SESSION || null, beforeSubmitPromptAt: env.T_PROMPT || null, gateAt: env.T_GATE || null, decisionAt: env.T_DECISION || null, slugifyAt: env.T_FILE || null },
  routing,
  parentConversation,
  cursorHooks,
  gateLog: gateRecords.map((g) => ({ ts: g.ts, tool: g.tool, action: g.action, reason: g.reason, phase: g.phase, tier: g.tier })),
  chat: { transcriptFound: fs.existsSync(transcriptPath), toolUses: transcriptToolUses, assistantTextTail: assistantText.slice(-1)[0]?.slice(-800) || null },
  hookEventsSeen: events,
  hookRecords: hooks.length,
  decisions: decisions.map((d) => ({ ts: d.ts, requested: d.requested, final: d.final, model: d.model, rewritten: d.rewritten, reason: d.reason, override: d.override, description: d.description })),
  auth,
  evidence: {
    dir: env.EVIDENCE_DIR,
    frames: Number(env.FRAME_COUNT),
    video: fs.existsSync(env.VIDEO_MP4) ? env.VIDEO_MP4 : null,
    hooksLog: path.join(env.OUT_DIR, "hooks.jsonl"),
    decisionsLog: path.join(env.OUT_DIR, "decisions.jsonl"),
    slugify: routing.slugifyCreated ? slugify : null,
    hooksJsonInstalled: path.join(env.EVIDENCE_DIR, "hooks.json.installed"),
    cursorHooksLog: fs.existsSync(cursorHooksLogPath) ? cursorHooksLogPath : null,
    chatTranscript: fs.existsSync(transcriptPath) ? transcriptPath : null,
    chatResponse: fs.existsSync(path.join(env.EVIDENCE_DIR, "chat-response.txt")) ? path.join(env.EVIDENCE_DIR, "chat-response.txt") : null,
  },
};
fs.writeFileSync(env.OUT_FILE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
fs.copyFileSync(env.OUT_FILE, path.join(env.EVIDENCE_DIR, "ide-auth-proof.json"));
console.log(JSON.stringify({ pass: out.pass, authPass, routingPass, routing, hookEventsSeen: events, decisions: out.decisions, cursorHooks, gateLog: out.gateLog, chat: out.chat, evidenceDir: env.EVIDENCE_DIR }, null, 2));
process.exit(out.pass ? 0 : 1);
NODE
STATUS=$?
if [[ "$STATUS" -ne 0 ]]; then
  echo "IDE proof failed. See: $OUT_FILE and $EVIDENCE_DIR" >&2
  exit 1
fi
echo "IDE proof generated: $OUT_FILE (evidence: $EVIDENCE_DIR)"
