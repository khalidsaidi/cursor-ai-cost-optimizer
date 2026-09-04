#!/usr/bin/env bash
# Live proof on a specific Cursor Linux build (x64 AppImage), e.g. under WSLg or any X11 display.
#
#   scripts/proof-cursor-linux.sh 3.13.25 https://downloads.cursor.com/production/<hash>/linux/x64/Cursor-3.13.25-x86_64.AppImage
#
# What it does: extracts the AppImage into a scratch dir, seeds a throwaway profile with your signed-in
# account (copies state.vscdb from $CURSOR_STATE_DB), installs the linux-x64 VSIX through Cursor's own CLI
# entry, opens a tiny fixture workspace, submits an edit task through Cursor's `prompt` deeplink
# (cursor://anysphere.cursor-deeplink/prompt?text=...) and reads Cursor's hooks log for a `Task` call with
# `subagent_type: cco-fast` plus a `subagentStop` on the fast-tier model. Requires the "Everywhere" setup
# already in ~/.cursor (the build under test loads the same user-level hooks and subagents).
# Needs: xdotool, ImageMagick `import`, node, DISPLAY. Everything it creates lives under $PROOF_ROOT.
set -euo pipefail
V=${1:?version}; URL=${2:?appimage url}
PROOF_ROOT=${PROOF_ROOT:-$HOME/cursor-proof}
CURSOR_STATE_DB=${CURSOR_STATE_DB:-/mnt/c/Users/$USER/AppData/Roaming/Cursor/User/globalStorage/state.vscdb}
HERE=$(cd "$(dirname "$0")/.." && pwd)
VSIX=$(ls "$HERE"/cursor-ai-cost-optimizer-*-linux-x64.vsix | tail -1)
export DISPLAY=${DISPLAY:-:0}
R=$PROOF_ROOT; X=$R/app-$V; UD=$R/ud-$V; EXT=$R/ext-$V; W=$R/ws-$V
mkdir -p "$R"
[ -f "$R/Cursor-$V.AppImage" ] || curl -sSL -o "$R/Cursor-$V.AppImage" "$URL"
[ -x "$X/AppRun" ] || (cd "$R" && chmod +x "Cursor-$V.AppImage" && "./Cursor-$V.AppImage" --appimage-extract >/dev/null && mv squashfs-root "app-$V")
rm -rf "$UD" "$EXT" "$W"; mkdir -p "$UD/User/globalStorage" "$EXT" "$W"
cp "$CURSOR_STATE_DB" "$UD/User/globalStorage/state.vscdb"
printf '{"workbench.startupEditor":"none","update.mode":"none","telemetry.telemetryLevel":"off","window.restoreWindows":"none","security.workspace.trust.enabled":false}\n' > "$UD/User/settings.json"
(cd "$W" && git init -q && printf '# tiny-calc\n\nA tiny calculator library used only to exercise the AI Cost Optimizer.\n' > README.md && printf 'export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n' > calc.mjs && git add -A && git -c user.email=p@p -c user.name=proof commit -qm init)
# --install-extension must go through cli.js; passing it to the Electron binary opens the GUI instead.
ELECTRON_RUN_AS_NODE=1 "$X/usr/share/cursor/cursor" "$X/usr/share/cursor/resources/app/out/cli.js" --user-data-dir="$UD" --extensions-dir="$EXT" --install-extension "$VSIX" 2>&1 | grep -i 'successfully installed'
( nohup "$X/AppRun" --no-sandbox --user-data-dir="$UD" --extensions-dir="$EXT" --new-window "$W" > "$R/run-$V.log" 2>&1 & )
for i in $(seq 1 30); do sleep 2; WIN=$(xdotool search --onlyvisible --name "ws-$V" | head -1 || true); [ -n "${WIN:-}" ] && break; done
[ -n "${WIN:-}" ] || { echo "no window"; exit 1; }
sleep 15
P='Add a sub(a, b) function to calc.mjs that returns a - b, export it, and add a one-line usage note to README.md.'
ENC=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$P")
"$X/AppRun" --no-sandbox --user-data-dir="$UD" --extensions-dir="$EXT" --open-url "cursor://anysphere.cursor-deeplink/prompt?text=$ENC" >/dev/null 2>&1
sleep 6; xdotool windowactivate --sync "$WIN"; xdotool key --window "$WIN" --clearmodifiers Return   # "Create Chat"
sleep 4; xdotool key --window "$WIN" --clearmodifiers Return                                            # send
LOG=""; for i in $(seq 1 60); do sleep 3; LOG=$(grep -l '"subagentStop"' "$UD"/logs/*/window*/output_*/cursor.hooks.workspaceId-*.log 2>/dev/null | head -1 || true); [ -n "$LOG" ] && break; done
import -window "$WIN" "$R/chat-$V.png" || true
echo "hooks log: ${LOG:-<none>}"
if [ -n "$LOG" ] && grep -q '"subagent_type": "cco-fast"' "$LOG" && grep -q '"tool_name": "Task"' "$LOG"; then
  echo "PASS $V: Task -> cco-fast, subagent model: $(grep -o '"model": "[^"]*"' "$LOG" | sort | uniq -c | sort -rn | head -1)"
  (cd "$W" && git --no-pager diff --stat)
else
  echo "FAIL $V: no Task -> cco-fast in hooks log"; exit 1
fi
pkill -9 -f "ud-$V" || true
