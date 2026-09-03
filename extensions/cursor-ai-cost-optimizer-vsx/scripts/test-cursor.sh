#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/test-fixtures/workspace"
EXT_TESTS_PATH="$ROOT_DIR/test/suite/index.js"
LOG_FILE="${TMPDIR:-/tmp}/cursor-ext-tests.log"
PROOF_FILE="$WORKSPACE_DIR/.ai/cco/test-proof.json"

if [[ ! -d "$WORKSPACE_DIR" ]]; then
  echo "Workspace fixture not found: $WORKSPACE_DIR" >&2
  exit 1
fi

if [[ ! -f "$EXT_TESTS_PATH" ]]; then
  echo "Extension tests entrypoint not found: $EXT_TESTS_PATH" >&2
  exit 1
fi

to_windows_path() {
  local p="$1"
  wslpath -w "$p" | tr -d '\r'
}

CURSOR_EXE_WIN="$(to_windows_path "/mnt/c/Users/khali/AppData/Local/Programs/cursor/Cursor.exe")"
CURSOR_CLI_WIN="$(to_windows_path "/mnt/c/Users/khali/AppData/Local/Programs/cursor/resources/app/out/cli.js")"
ROOT_REMOTE="vscode-remote://wsl+Ubuntu$ROOT_DIR"
TESTS_REMOTE="$ROOT_REMOTE/test/suite/index.js"
WORKSPACE_REMOTE="$ROOT_REMOTE/test-fixtures/workspace"
LOGIN_WAIT_SECONDS="${CCO_LOGIN_WAIT_SECONDS:-0}"
POST_RUN_HOLD_SECONDS="${CCO_POST_RUN_HOLD_SECONDS:-20}"
SOURCE_USERDATA_WIN="${CCO_CURSOR_USERDATA_SOURCE_WIN:-C:\\Users\\khali\\AppData\\Roaming\\Cursor}"
USE_SHARED_USERDATA="${CCO_USE_SHARED_USERDATA:-0}"
DISABLE_EXTENSIONS="${CCO_DISABLE_EXTENSIONS:-1}"

if ! powershell.exe -NoProfile -Command "Test-Path '$CURSOR_EXE_WIN'" | tr -d '\r' | grep -Eq '^True$'; then
  echo "Cursor executable not found at $CURSOR_EXE_WIN" >&2
  exit 1
fi

if ! powershell.exe -NoProfile -Command "Test-Path '$CURSOR_CLI_WIN'" | tr -d '\r' | grep -Eq '^True$'; then
  echo "Cursor CLI entrypoint not found at $CURSOR_CLI_WIN" >&2
  exit 1
fi

USER_DATA_WIN="C:\\Users\\khali\\AppData\\Local\\Temp\\cursor-exttest-$(date +%s)"
if [[ "$USE_SHARED_USERDATA" == "1" ]]; then
  USER_DATA_WIN="$SOURCE_USERDATA_WIN"
fi
PS_SCRIPT="$(mktemp /tmp/cco-cursor-test-XXXX.ps1)"

cat > "$PS_SCRIPT" <<'PS'
param(
  [string]$CursorExe,
  [string]$CursorCli,
  [string]$UserDataDir,
  [string]$RootRemote,
  [string]$TestsRemote,
  [string]$WorkspaceRemote,
  [string]$SourceUserData,
  [string]$UseSharedUserData,
  [string]$DisableExtensions,
  [string]$LoginWaitSeconds,
  [string]$PostRunHoldSeconds
)

$ErrorActionPreference = 'Stop'

if ($UseSharedUserData -ne '1' -and (Test-Path $SourceUserData)) {
  New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
  $skipNames = @('code.lock', 'SingletonLock', 'SingletonCookie', 'SingletonSocket')
  $items = Get-ChildItem -Path $SourceUserData -Force -ErrorAction SilentlyContinue |
    Where-Object { $skipNames -notcontains $_.Name }

  foreach ($item in $items) {
    $dst = Join-Path $UserDataDir $item.Name
    Copy-Item -Path $item.FullName -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Auth/profile seed copied from $SourceUserData (full profile)"
}

$env:ELECTRON_RUN_AS_NODE = '1'
$env:CCO_LOGIN_WAIT_SECONDS = $LoginWaitSeconds
$env:CCO_POST_RUN_HOLD_SECONDS = $PostRunHoldSeconds

$args = @(
  '--wait',
  '--verbose',
  "--user-data-dir=$UserDataDir",
  "--extensionDevelopmentPath=$RootRemote",
  "--extensionTestsPath=$TestsRemote",
  "--folder-uri=$WorkspaceRemote",
  '--remote=wsl+Ubuntu'
)

if ($DisableExtensions -eq '1') {
  $args = @('--disable-extensions') + $args
}

& $CursorExe $CursorCli @args
exit $LASTEXITCODE
PS

echo "Running Cursor extension tests with isolated user data: $USER_DATA_WIN"
echo "Log file: $LOG_FILE"
echo "Auth source: $SOURCE_USERDATA_WIN"
echo "Use shared user-data dir: $USE_SHARED_USERDATA"
echo "Disable extensions: $DISABLE_EXTENSIONS"
echo "Login wait: ${LOGIN_WAIT_SECONDS}s"
echo "Post-run hold: ${POST_RUN_HOLD_SECONDS}s"

rm -f "$LOG_FILE"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PS_SCRIPT" "$CURSOR_EXE_WIN" "$CURSOR_CLI_WIN" "$USER_DATA_WIN" "$ROOT_REMOTE" "$TESTS_REMOTE" "$WORKSPACE_REMOTE" "$SOURCE_USERDATA_WIN" "$USE_SHARED_USERDATA" "$DISABLE_EXTENSIONS" "$LOGIN_WAIT_SECONDS" "$POST_RUN_HOLD_SECONDS" > "$LOG_FILE" 2>&1 || true
rm -f "$PS_SCRIPT"

if grep -Eq "Running extension tests from the command line is currently only supported|AssertionError|tests failed|failing" "$LOG_FILE"; then
  echo "Cursor extension tests failed. See: $LOG_FILE" >&2
  tail -n 80 "$LOG_FILE" >&2
  exit 1
fi

if grep -Eq "[0-9]+ passing" "$LOG_FILE"; then
  grep -En "[0-9]+ passing" "$LOG_FILE"
  if [[ -f "$PROOF_FILE" ]]; then
    echo "Proof file: $PROOF_FILE"
  else
    echo "Warning: passing result detected but proof file missing at $PROOF_FILE" >&2
  fi
  exit 0
fi

echo "Could not confirm test pass status. See: $LOG_FILE" >&2
tail -n 80 "$LOG_FILE" >&2
exit 1
