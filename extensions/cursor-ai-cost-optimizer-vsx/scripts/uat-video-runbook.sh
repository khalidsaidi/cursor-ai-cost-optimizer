#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="$(date +%s)"
OUT_DIR="$ROOT_DIR/.ai/uat-video/$RUN_ID"
FRAMES_DIR="$OUT_DIR/frames"
LOG_FILE="$OUT_DIR/cursor-uat.log"
SUMMARY_JSON="$OUT_DIR/summary.json"
RUNBOOK_MD="$OUT_DIR/runbook.md"
VIDEO_MP4="$OUT_DIR/uat-run.mp4"

CAPTURE_INTERVAL_SECONDS="${UAT_CAPTURE_INTERVAL_SECONDS:-2}"
POST_RUN_HOLD_SECONDS="${UAT_POST_RUN_HOLD_SECONDS:-60}"
RUN_PROOF_INTENT="${UAT_RUN_PROOF_INTENT:-true}"

mkdir -p "$FRAMES_DIR"
rm -f "$FRAMES_DIR"/frame-*.png "$VIDEO_MP4" "$LOG_FILE" "$SUMMARY_JSON" "$RUNBOOK_MD"

capture_frame() {
  local idx="$1"
  local frame_path="$FRAMES_DIR/frame-$(printf '%04d' "$idx").png"
  local frame_win
  frame_win="$(wslpath -w "$frame_path" | tr -d '\r')"

  powershell.exe -NoProfile -Command "& { param([string]\$out); Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; \$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \$bmp=New-Object System.Drawing.Bitmap \$bounds.Width,\$bounds.Height; \$g=[System.Drawing.Graphics]::FromImage(\$bmp); \$g.CopyFromScreen(\$bounds.Location,[System.Drawing.Point]::Empty,\$bounds.Size); \$bmp.Save(\$out,[System.Drawing.Imaging.ImageFormat]::Png); \$g.Dispose(); \$bmp.Dispose() }" "$frame_win" >/dev/null 2>&1 || true
}

echo "Starting Cursor end-user UAT run..."
echo "Output directory: $OUT_DIR"
echo "Capture interval: ${CAPTURE_INTERVAL_SECONDS}s"
echo "Post-run hold: ${POST_RUN_HOLD_SECONDS}s"

(
  cd "$ROOT_DIR"
  CCO_POST_RUN_HOLD_SECONDS="$POST_RUN_HOLD_SECONDS" npm run test:cursor > "$LOG_FILE" 2>&1
) &
TEST_PID=$!

frame_idx=1
while kill -0 "$TEST_PID" 2>/dev/null; do
  capture_frame "$frame_idx"
  frame_idx=$((frame_idx + 1))
  sleep "$CAPTURE_INTERVAL_SECONDS"
done

TEST_EXIT=0
if ! wait "$TEST_PID"; then
  TEST_EXIT=$?
fi

# Capture final frame after process exit.
capture_frame "$frame_idx"

FRAME_COUNT="$(find "$FRAMES_DIR" -maxdepth 1 -name 'frame-*.png' | wc -l | tr -d ' ')"

if command -v ffmpeg >/dev/null 2>&1 && [[ "$FRAME_COUNT" -gt 1 ]]; then
  ffmpeg -y -loglevel error -framerate 1 -i "$FRAMES_DIR/frame-%04d.png" -vf "format=yuv420p" "$VIDEO_MP4" || true
fi

PROOF_FILE="$ROOT_DIR/test-fixtures/workspace/.ai/cco/test-proof.json"
MANIFEST_FILE="$ROOT_DIR/test-fixtures/workspace/.cursor/cco/install-manifest.json"
HOOK_MODE="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hookMode||"unknown")}catch{console.log("unknown")}' "$MANIFEST_FILE")"
INTENT_FILE="$ROOT_DIR/test-fixtures/workspace/.ai/cco/proof-intent-report.json"

PROOF_INTENT_EXIT=0
if [[ "$RUN_PROOF_INTENT" == "true" ]]; then
  (
    cd "$ROOT_DIR"
    CCO_POST_RUN_HOLD_SECONDS=5 ./scripts/proof-intent.sh >> "$LOG_FILE" 2>&1
  ) || PROOF_INTENT_EXIT=$?
fi

HAS_VIDEO="false"
if [[ -f "$VIDEO_MP4" ]]; then
  HAS_VIDEO="true"
fi

HAS_PROOF_FILE="false"
if [[ -f "$PROOF_FILE" ]]; then
  HAS_PROOF_FILE="true"
fi

HAS_INTENT_FILE="false"
if [[ -f "$INTENT_FILE" ]]; then
  HAS_INTENT_FILE="true"
fi

OVERALL_PASS="false"
if [[ "$TEST_EXIT" -eq 0 && "$PROOF_INTENT_EXIT" -eq 0 && "$HAS_PROOF_FILE" == "true" && "$HAS_INTENT_FILE" == "true" ]]; then
  OVERALL_PASS="true"
fi

cat > "$SUMMARY_JSON" <<EOF
{
  "generatedAt": "$(date -Iseconds)",
  "overallPass": $OVERALL_PASS,
  "testCursorExitCode": $TEST_EXIT,
  "proofIntentExitCode": $PROOF_INTENT_EXIT,
  "captureIntervalSeconds": $CAPTURE_INTERVAL_SECONDS,
  "postRunHoldSeconds": $POST_RUN_HOLD_SECONDS,
  "frameCount": $FRAME_COUNT,
  "hookMode": "$HOOK_MODE",
  "hasVideo": $HAS_VIDEO,
  "videoPath": "$VIDEO_MP4",
  "logPath": "$LOG_FILE",
  "proofPath": "$PROOF_FILE",
  "intentPath": "$INTENT_FILE",
  "runProofIntent": "$RUN_PROOF_INTENT"
}
EOF

cat > "$RUNBOOK_MD" <<EOF
# Human-Observable UAT Video Runbook

## Result
- Overall pass: **$OVERALL_PASS**
- Cursor flow exit code: **$TEST_EXIT**
- Proof-intent exit code: **$PROOF_INTENT_EXIT**
- Frames captured: **$FRAME_COUNT**
- Installed hook mode: **$HOOK_MODE**
- Video available: **$HAS_VIDEO**

## Artifacts
- Summary JSON: [summary.json]($SUMMARY_JSON)
- UAT log: [cursor-uat.log]($LOG_FILE)
- Video (MP4): [uat-run.mp4]($VIDEO_MP4)
- Frame directory: [$FRAMES_DIR]($FRAMES_DIR)
- Runtime proof: [test-proof.json]($PROOF_FILE)
- Intent proof: [proof-intent-report.json]($INTENT_FILE)

## How this was executed
1. Run \`npm run test:cursor\` with extended hold time so UI remains visible.
2. Capture desktop frames every \`${CAPTURE_INTERVAL_SECONDS}s\` during the full run.
3. Build MP4 from captured frames.
4. Run full \`./scripts/proof-intent.sh\` for machine-verifiable claim checks.

## End-user checks represented (v0.2.0)
1. Extension command flow (install, uninstall, insert tokens) runs in real Cursor desktop (WSL remote).
2. Workspace assets are installed: \`.cursor/{rules,agents,skills,commands}\`, \`.cursor/cco/{scripts,config,agents[,bin]}\`.
3. \`.cursor/hooks.json\` carries the CCO hook entries (binary or node form) and preserves foreign entries; uninstall removes only ours.
4. Override insertion behavior is validated.
5. Guardrail/tier intent checks pass in final proof report (\`proof-intent.sh\`).
6. For the real in-IDE routing proof (chat -> hooks -> subagent delegation), see \`scripts/proof-ide-auth.sh\`.
EOF

echo "UAT runbook generated:"
echo "  $RUNBOOK_MD"
echo "Summary:"
cat "$SUMMARY_JSON"

if [[ "$OVERALL_PASS" != "true" ]]; then
  exit 1
fi
