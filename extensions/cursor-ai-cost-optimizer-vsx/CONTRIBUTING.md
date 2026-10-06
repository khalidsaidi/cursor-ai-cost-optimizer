# Contributing / building

This extension is a thin installer around the `cursor-ai-cost-optimizer` plugin that lives in the same
repository (`plugins/cursor-ai-cost-optimizer`). `resources/plugin/` is a generated copy of it.

## Layout

- `src/install.ts` — vscode-free install/doctor/uninstall logic (unit-tested with `node:test`).
- `src/extension.ts` — commands, status bar, doctor on activation, confirmation dialog, log channel.
- `src/scorer.ts` — TypeScript port of the plugin's `scripts/lib/scorer.mjs` (parity-tested).
- `resources/plugin/` — straight copy of the plugin (`rules`, `agents`, `skills`, `commands`, `scripts`,
  `config`, `hooks/hooks.json`); `CCO_PLUGIN_ROOT` for the plugin scripts run by the extension.
- `resources/entry/` — bundle-only copies of the scripts whose `main()` guards are keyed on
  `CCO_HOOK_MAIN`, plus the generated `cco-hook-bundle.mjs` the binaries are compiled from.
- `bin/` / `dist-bin/<target>/` — compiled `cco-hook[.exe]` (bun for five targets; win32-arm64 via Node
  SEA with esbuild + postject and the official win-arm64 `node.exe`).

## Build

```bash
npm i
npm run sync:assets          # copy the plugin, generate the bundle entry, render resources/icon.png
npm run compile              # TypeScript -> dist/
npm run compile:binaries     # dist-bin/<host>/cco-hook and bin/ (host only; compile:binaries:all = 6 targets)
npm run package              # cursor-ai-cost-optimizer-<version>-<host>.vsix (bin/ for the host)
npm run package:all          # one VSIX per target; package:universal = no binaries (node fallback only)
```

`scripts/package-extension.mjs` ships a lean manifest (no dev `scripts` except `vscode:uninstall`, no `devDependencies`) and restores `package.json` afterwards. `scripts/compile-binaries.mjs --skip-sea` skips the win32-arm64 SEA build (needs network for `node.exe`, or
`CCO_SEA_NODE_EXE`). `scripts/publish-openvsx.mjs` publishes every target with `ovsx publish <vsix> --target`;
`--dry-run` prints the commands.

## Tests

```bash
npm run test:unit         # node:test: install/doctor/uninstall, scorer parity, compiled-binary behaviour (uses test/fixtures/fake-cursor-agent.sh)
npm run test:integration  # headless extension-host tests via @vscode/test-electron + xvfb-run
npm test                  # both
```

The integration suite installs into `test-fixtures/workspace` and passes `{ confirm: false }` to the install
command to skip the modal.

## Real-IDE proofs (Windows + WSL)

- `npm run test:cursor` — the extension test suite inside the real Cursor desktop (isolated user-data dir
  seeded from your profile; `scripts/test-cursor.sh`).
- `npm run uat:video` — records that run (frames + MP4 + runbook) under `.ai/uat-video/<run-id>/`.
- `npm run proof:ide-auth` — installs into the fixture, opens Cursor on it, sends a real chat prompt via
  SendKeys and asserts on disk (`.cursor/cco/state/hooks.jsonl`, `decisions.jsonl`, created files); evidence under
  `.ai/ide-proof/<run-id>/` including Cursor's own hooks log and the chat transcript.
- `scripts/factcheck-user-level.sh` — single-run IDE fact-check for user-level `~/.cursor/rules` /
  `~/.cursor/agents` loading (evidence under `.ai/ide-factcheck/<run-id>/`).
- `npm run proof:no-stone` — chains the plugin's real E2E, natural-prompt routing asserted via
  `decisions.jsonl`, the functional proof and the IDE proof into one report.
