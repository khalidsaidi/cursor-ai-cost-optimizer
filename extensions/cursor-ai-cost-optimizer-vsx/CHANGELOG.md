# Changelog

All notable changes to this extension are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-09-05

### Changed
- Install and forget. The extension turns itself on at install (once per machine; **Undo** on the one toast; anyone who removed it is never re-enrolled). Turning on takes seconds, asks nothing (no modal, no probing, no reload: the routing rule now arrives through the session hook, so the current window routes from its next chat), and ends with one line: "AI Cost Optimizer is on. Fast → Composer 2.5 · Balanced → Claude Sonnet 5 · Deep → Claude Opus 5." with **Details** and **Undo**.
- The status bar is the receipt: `⚡ Saved ~$4.12` (this project), `AI Cost: Off`, `AI Cost: Paused`; the tooltip shows each tier's model next to your chat model's price, the last task (tier, model, cost, saved) and the project total, in plain words.
- Subagents are named for the user, because Cursor shows the name on the card: **Fast Tier**, **Balanced Tier**, **Deep Tier**, Fast Research, Tier Verifier (files `fast-tier.md` …). Old `cco-*` names still route; generated `cco-*.md` files are replaced on update and removed on uninstall.
- No model-written cost lines in chat: the chat model relays the subagent's result and adds nothing; the card and the status bar carry the numbers.
- **Choose tier models** (status menu): pick which model runs Fast, Balanced and Deep from the models this account can use; applies to all projects (or this project) at once.
- Everything the user reads is plain language: the card line says `Fast on Composer 2.5 · ~$0.02, saves ~$0.04`, `Risky or complex change: routing to Deep (Claude Opus 5)` or `Working in chat on Grok 4.6.` No "CCO:", no FAST/BALANCED/DEEP, no raw model ids, no reason codes, no repeated "[cco:deep]" hints.
- Menu and commands renamed to what they do: Turn on, Savings and tier rates, Pause here / Resume here, Update models, Remove from Cursor.

### Fixed
- Fresh IDE-only users (no logged-in Cursor CLI) ended up with every tier on `inherit`, i.e. no savings: setup probed each candidate through the CLI, every probe failed with "authentication required", and all candidates were discarded. Probing is skipped when the model list itself came from the bundled catalogue, and an account-level probe failure stops probing and keeps the ranked candidates unverified. Found in a fresh-user UI run on Cursor 3.17.
- **Pause / Resume in This Project** only silenced the hooks; the routing rule and the user-level subagents still delegated, and the chat then invented a cost footer. A paused project now tells the chat to work normally and turns `cco-*` delegations back into in-chat work.
- Chat start waited on the network: the `sessionStart` hook refreshed the price table inline (20 s behind a blackholing proxy) and ran `cursor-agent --version` on every chat (0.65 s). Refreshes now run in a detached worker; the CLI version is cached per binary identity; chat start answers in about 0.1 s.
- A tier model at its usage limit (seen with Opus on a Pro account) failed every DEEP task the same way; the model is now put on a 6-hour cooldown, delegations step down a tier with a one-line note, and the chat finishes the task itself when nothing lower is usable.
- Honest footers: when the chat never delegated (escape hatch) or a subagent died, the hook now gives the exact in-chat footer instead of letting the model name a model it never used.
- A model the account keeps refusing (three refusals across 12+ hours: a plan or team restriction, or a disabled model) is dropped from the tier candidates and the tier is re-mapped at once; a usage limit stays a 6-hour cooldown with a step-down. Limits are shared by all projects.
- Two subagents stopping in the same turn were collapsed into one event by the duplicate filter, so the second one's failure went unhandled.
- Windows: `.cmd`/`.bat` launchers of `cursor-agent` are spawned through a shell (Node 18+ refuses them directly).
- Status bar reads `AI Cost: set up` until the extension is set up.

### Changed
- An empty window (no folder) is no longer treated as a workspace by the user-level hooks.

## [0.2.0] - 2026-09-02

### Fixed
- After an Everywhere setup the current window did not get the routing rule (Cursor requests plugin paths only at workspace open); the setup notification now offers Reload Window. Found in a native Windows Cursor run.

### Added
- First-party conventions: type-aware ESLint in CI, `vscode.l10n` with an exported bundle, command `enablement` via context keys, cancellable setup, live reaction to setting changes, activation timing in the log.
- Inner workings to the first-party bar: no synchronous child processes on the extension host (setup, repair, pause and removal are async), activation work deferred 1.5 s, a self-check that runs the real hook command once per activation and turns the hooks off with one message if it fails, a **Turn hooks off now** kill switch, and tight per-call hook timeouts (a hung hook is killed after 7 s).
- "Everywhere" setup (default): nothing written into any project. CCO registers in Cursor's user-level config (`~/.cursor/hooks.json` entries, `~/.cursor/agents/cco-*.md`) and keeps its state in the extension's storage; the routing rule is handed to Cursor per workspace through `workspaceOpen.pluginPaths`. Pause per project from the status menu; Remove and the extension's uninstall hook leave nothing behind.
- Minimal footprint: setup writes only what routing needs (hooks, shim, rule, five subagents; 8 files) and states the count, the per-call cost and the commit-or-ignore choice in the consent dialog. Skills and chat commands are no longer copied into the workspace.
- Six platform-targeted builds (Linux x64/ARM64, Windows x64/ARM64, macOS Intel/Apple Silicon), each compiled,
  tested, packaged and install-verified on a native runner in CI; `npm run verify:vsix` installs the packaged VSIX
  into a real VS Code and lists it back.
- Advise-first hooks: cost routing is advice attached to tool calls, never a block; explicit `[cco:<tier>]` overrides
  and quality escalations are enforced; `enforcement.mode: "strict"` in `.cursor/cco.json` enforces everything.
- Hook entries run the committed shim `node .cursor/cco-hook.mjs` by default so `.cursor/hooks.json` stays portable
  for teammates; the bundled binary is the fallback for machines without Node.
- Project-local setup identical to the marketplace plugin: the install command runs the bundled plugin's
  `cco-init` for the open workspace (`.cursor/hooks.json` merged, `.cursor/agents/cco-*.md` with real model ids,
  `.cursor/cco.json`, `.cursor/cco/`), then adds the routing rule, skills and commands under `.cursor/`.
- Self-contained `cco-hook` binary per platform (linux-x64/arm64, darwin-x64/arm64, win32-x64 via bun;
  win32-arm64 via Node SEA) so hooks run without Node.js; hook commands use the absolute binary path.
- Uninstall command (plugin's `cco-init --uninstall` plus the extension's additions; foreign hook entries kept).
- Doctor on activation: repoints stale binary/plugin paths and refreshes the binary after extension updates,
  with a "Don't show again" option and a dedicated log channel (`AI Cost Optimizer: Show Log`).
- Confirmation dialog listing the files to be created before the first write.
- Status bar item `CCO: on/off` with the tier → model mapping; getting-started walkthrough.
- Settings `cco.hookRuntime` and `cco.nodePath` (machine scope).
- Recommend Tier is a cost statement: each tier's model with its rate relative to your chat model
  (`Rate is counted at 0.1x.`), or absolute $/M prices before the first chat; plus the recommended tier for selected text.
- Status bar tooltip shows tier rates and estimated savings from `decisions.jsonl`; a warning icon flags a stale
  price table (> 7 days) or a tier still on `inherit`.
- Every error notification has a "View Logs" action; first-run/what's-new notice (once per version);
  `cco.collectDiagnostics` copies a bug-report summary to the clipboard; `vscode:uninstall` hook cleans global storage.
- Settings `cco.suppressPrompts` (`doctorRepaired`, `installNotice`); removed settings are cleared automatically with one warning.

### Changed
- Display name aligned to "AI Cost Optimizer"; commands moved to that category; activation on startup.
- No more `.ai/` directories or `.gitignore` edits in workspaces.

### Fixed
- Windows: hook commands in binary mode are written as `"<abs path>\cco-hook.exe" <event>` (quoted, backslashes kept);
  previously a Windows path could be written unquoted and Cursor failed to start the hook.
- Reinstalling never resets tier models: the plugin's generated marker is respected and user-authored agent files are
  left untouched.

### Removed
- Settings `cco.budgetPressure` and `cco.economyMode` (unused; cleared on first activation).

## [0.1.0] - 2026-03-01

### Added
- Initial release: copies the routing rule, tiered subagents and skills into `.cursor/`; Recommend Tier and
  override-token commands.
