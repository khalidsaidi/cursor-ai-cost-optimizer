# Changelog

All notable changes to this extension are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-09-05

### Changed
- Routing works in the Cursor CLI: the CLI's Task tool lists plugin agents but not `~/.cursor/agents`, so Everywhere setup mirrors the generated subagents into an agents-only local plugin (`~/.cursor/plugins/local/cco-agents`, no hooks, rules or commands; removed on uninstall). Before, a CLI session told the user "CCO tier subagents aren't available" and did the work itself.
- Tiny one-file changes stay in the chat: measured through the CLI, a one-line addition cost $0.070 delegated against $0.064 done in place, so the Task guard turns such delegations back into in-chat work (a Fast model the user chose still gets them). Mid-size work is where routing pays: $0.24 on Grok direct against about $0.11 routed for a module plus tests plus docs, with the tests passing.
- A task that adds tests in a project without a test runner tells the subagent to run the test files it writes before finishing (a routed run had handed back one failing test the parent could not re-check).
- Reasoning effort is matched to the tier: Balanced prefers the medium-effort variant of its model (`claude-sonnet-5-medium`, `cursor-grok-4.6-medium`, …) and Deep keeps high; estimates price the effort level (output tokens × 0.7 low, 1.0 medium, 1.5 high, 2.0 xhigh, 3.0 max, thinking × 1.3, `budgets.effortOutputFactor`), and labels show a non-default effort ("Claude Sonnet 5 (medium effort)"). Subagent card names stay short.
- A delegated task shows its diffs in the chat like the chat model's own edits: the tier subagents end their reply with a `Changes` section (one fenced diff per edited file, capped at 60 lines each) and the relay keeps those blocks. Cursor renders them as diff views. The repair pass re-renders the generated subagents whenever the templates change (a hash of them is kept in the manifest).
- The savings figure carries its share: "Saved about $0.49 (29%) in this project (14 routed tasks)" in the tooltip and the Savings view, since cents alone say little. The listing shows what a routed task, the tooltip, the picker and the Get Started page look like; the walkthrough says the subagent card can be clicked to see its steps and diffs.
- No popups. Nothing is shown at install, on update, pause, remove or tier changes: the status bar item is the whole UI (state, savings, tooltip receipt, menu) and actions the user took get a 4-second status bar message. The only notifications left are errors. Confirmation dialogs are gone too (Remove and "This project only" act on the explicit menu choice).
- Install and forget. The extension turns itself on at install (once per machine; anyone who removed it is never re-enrolled). Turning on takes seconds, asks nothing (no modal, no probing, no reload: the routing rule now arrives through the session hook, so the current window routes from its next chat), and ends with one line: "AI Cost Optimizer is on. Fast → Composer 2.5 · Balanced → Claude Sonnet 5 · Deep → Claude Opus 5." with **Details** and **Undo**.
- The status bar is the receipt: `⚡ Saved ~$4.12` (this project), `AI Cost: Off`, `AI Cost: Paused`; the tooltip shows each tier's model next to your chat model's price, the last task (tier, model, cost, saved) and the project total, in plain words.
- Everywhere runs the compiled hook binary when the build has one (median 72 ms per tool call measured in Cursor, versus ~140 ms for a Node start); the routing rule is 2.8 KB instead of 4.7 KB and small tasks go straight to the Fast tier instead of through a research subagent first.
- Subagents are named after the model they run on, because the card in the chat shows the name and "Fast Tier" means nothing to a user: **Composer 2.5 Fast**, **Claude Sonnet 5 Balanced**, **Claude Opus 5 Deep** (files `composer-2.5-fast.md` …, recorded in `agent-names.json`; they follow the mapping when you pick other models). Old names still route; generated files under other names are swept on update and uninstall.
- The Get Started page opens once after the quiet install and shows the user's actual tiers with a **Choose tier models** link next to them; the same picker is in the status menu and the values are Settings (`costOptimizer.tierModels.*`).
- Per-call hooks only for delegations, edits and shell commands (reads are free): measured inside Cursor on Windows, any hook costs ~330 ms to spawn and ~650 ms in total, so fewer hooked calls is the lever there.
- No model-written cost lines in chat: the chat model relays the subagent's result and adds nothing; the card and the status bar carry the numbers.
- Settings UI: `costOptimizer.autoEnable`, `costOptimizer.tierModels.{fast,balanced,deep}`, `costOptimizer.enforceRouting`, `costOptimizer.alwaysDelegate`, `costOptimizer.chatBudgetUsd`, `costOptimizer.modelCooldownHours`, `costOptimizer.showSavingsInStatusBar` (user scope = every project, workspace scope = this project). They are mirrored into the plugin config the hooks read; tier model changes re-map at once. **Choose tier models** in the status menu writes the tier settings from the list of models this account can use.
- Everything the user reads is plain language: the card line says `Fast on Composer 2.5 · ~$0.02, saves ~$0.04`, `Risky or complex change: routing to Deep (Claude Opus 5)` or `Working in chat on Grok 4.6.` No "CCO:", no FAST/BALANCED/DEEP, no raw model ids, no reason codes, no repeated "[cco:deep]" hints.
- Menu and commands renamed to what they do: Turn on, Savings and tier rates, Pause here / Resume here, Update models, Remove from Cursor.

### Fixed
- The cost model is calibrated on Cursor's own bill instead of guessed token volumes: one Fast task bills about 18k input, 3k output and 120k cache-read tokens on the Composer subagent, about 3k / 1.5k / 98k done in an ongoing chat, and the chat pays about 2.8k / 0.7k / 48k to dispatch and relay a delegation; cache reads are the largest line because every request re-reads the context. Auto is priced at what Cursor bills it: one fixed rate ($2.00 per million input tokens, $0.50 cache read, $6.00 output) fitted exactly to eight billed requests, not the old Enterprise estimate and not "the model it picked" as earlier wording claimed. Under that model a Fast delegation from Auto, Composer, Grok, Sonnet or GPT costs the same or more than the work (measured on Auto: 6.4¢ in the chat, 7.5¢ delegated; 9.3¢ against 9.5¢ in a fresh chat), so routine work stays in the chat there and routes only from Opus-class chat models. Earlier notes in this entry that claimed a 30% saving on Auto rested on one pair where Auto took an expensive path and are withdrawn.
- A chat panel of the extension's own (`AI Cost Chat` in the activity bar): the picker in Cursor's chat names the chat model whatever ran, and no extension can change that pixel, so this panel renders the conversation itself. Every reply is shown under the model that produced it, with tool rows, inline diffs, per-turn cost from the CLI's token usage and the same tokens at Auto's rate. Requests are routed by the scorer (or a forced tier) and run on the tier's model through the Cursor CLI on the user's account. React webview structured after Cline and Roo Code (Apache-2.0; see THIRD_PARTY_NOTICES.md), bundled with esbuild.
- When a subagent finishes, the parent is told (on subagentStop, the only event the IDE fires for a finished Task) to relay the subagent's message verbatim, its "Done by" line and diff blocks included; left alone, the chat model paraphrased it and dropped both.
- The status bar names where the last task actually ran ("Composer 2.5 · Fast" or "In chat · Auto"), because the chat's own picker keeps showing the chat model whatever the extension did; a subagent's final message opens with "Done by <model> (<tier> tier)." so the chat itself says which model did the work.
- A switch to Auto in the picker mid-chat now counts ("default" is a choice, not a placeholder) and the chat is briefed again with the new model's numbers.
- In the Cursor CLI an Auto chat's subagents run and are billed as Auto too, so delegating from there cost more (13.7¢ direct, 24.9¢ with a Fast subagent). The hooks now tell the CLI apart from the IDE (`CURSOR_INVOKED_AS`, dated version string) and a CLI Auto chat keeps routine work in the chat: the short rule, and the Task guard turns such delegations back ("Auto in the CLI: done in the chat."); a tier the user forces with `[cco:…]` is still honoured. Even so, on this task an Auto CLI chat with the extension billed 16 to 18¢ against 14 to 15¢ without it (the briefing, plus Auto's own variance), so the extension does not pay for itself in a CLI Auto chat; in the IDE it is the Deep-tier guardrail, the tiny-task rule and the visibility that carry their weight on such models.
- Everywhere no longer adds `/cco-init`, `/cco-model-config`, `/cco-report` and the other plugin commands to the slash menu of every chat: `/cco-init` was a project-scope setup that contradicts "nothing written into projects", and the status menu covers the rest. A runtime plugin dir from an earlier build is removed by the repair pass.
- An Ask chat (no tools) is no longer briefed with the routing rule on its first prompt; the briefing arrives once the chat is in Agent or Plan mode.
- Every shell command paid a `beforeShellExecution` hook spawn (about 70 ms on Linux, 650 ms on Windows) for a guard that is off by default. That hook is now registered only when `shellGuard.enabled` is on; the routing gate still sees shell commands through `preToolUse`.
- A hook binary that cannot run on the machine (a quarantined download on macOS, a noexec mount, an unexpected libc) used to turn the hooks off with a popup. The self-check now switches the hooks to Node.js (from PATH or Cursor's own runtime) and says so in a 4-second status message; only when that fails too are the hooks turned off, shown as "AI Cost: hooks off" with the reason in the tooltip, no popup. Verified live: binary replaced by a failing script → hooks on Node.js in 172 ms, routing unchanged.
- On Auto, the chat's price is a guess until a hook payload names the model Cursor picked, so nothing is denied on that guess: the chat model's own routing choice stands and no advice is attached.
- Savings and "worth delegating" are now net of the subagent's own session start (about 38k cached tokens, `budgets.sessionOverheadTokens`). Before, "Balanced on Claude Sonnet 5 · saves ~$0.02" from a Grok chat was a loss of about $0.08 once that start was paid, and Auto chats were routed for nothing. Now: Fast delegation from Grok saves about $0.02 per task (shown as such), from Opus about $0.08; Balanced from Grok, anything from Composer, and anything from an Auto chat in the Cursor CLI, stays in the chat. The minimum saving to delegate is 20% (`enforcement.minSavingsFactor` 1.2).
- Risk is a floor, not the parent's opinion: a chat model that scored a production OAuth-secret change risk=5 sent it to the cheapest tier. The user's own prompt is scored too and the higher risk counts, so such work is rerouted to Deep (seen live: Deep, then the account's usage limit, then the step-down).
- When a delegation to a stronger model dies at startup (usage limit), the next tier is told through `additional_context` (Cursor 3.17 does not deliver a follow-up message from subagentStop), and edits in the chat are held until that retry is made, even in advise mode; risky work never steps down to the Fast tier (the chat model finishes it and says so). A failed delegation is taken back out of the savings figure. Card lines read "Deep model at its usage limit: retrying on Balanced (Claude Sonnet 5)" instead of "moved from Fast: risk force deep".
- A `hooks.json` that is not valid JSON (another tool left it broken; Cursor was loading no hooks from it) used to be replaced silently, losing the other entries. It is now copied next to itself as `hooks.json.broken-<time>` first, the setup output says so, and a 4-second status message tells the user.
- A tier model typed in Settings that the account does not list was skipped silently (the tier kept its automatic model and nothing said so). The status bar now shows a warning and the tooltip names the id and the model in use; the same message flashes after the re-map.
- The chat model is re-read on every prompt. Switching the picker mid-chat (Composer 2.5 Fast to plain Composer 2.5, the Fast tier's own model) used to leave the hooks on the first prompt's model, so the chat delegated to an identical model and counted it as savings; now that task stays in the chat and the tooltip says why ("Composer 2.5 already costs no more than the Fast tier"). Tasks kept in the chat no longer count as routed tasks.
- "no subagents", "do it yourself", "directly", "in this chat" in a prompt switch routing off for that turn. In enforce mode such a request used to have its edits blocked twice, after which the model wrote the file through a shell command.
- **Savings and tier rates** opens on the savings, the last task and the rates; it no longer asks for a prompt to score first (that is a sub-item now).
- A copy of the Cursor plugin next to the extension (a `~/.cursor/plugins/local` copy from the CLI, or the marketplace plugin) kept its `cco-*` subagents (which run on the chat model) and its hooks running alongside ours, and Cursor's subagent list then held on to those names and rejected the extension's. The repair pass now retires a local copy (moved under the extension's storage, reversible) and, for a marketplace copy, says so in the status tooltip and menu with the uninstall path. Seen on the maintainer's machine; this is the common upgrade path from the plugin to the extension.
- Remote windows (WSL, SSH, containers): Cursor's Task tool lists the subagents it knew when the window opened and never refreshes that list, so after an update, a re-map or a first setup made in that window every delegation failed with "Invalid enum value" (seen live in a WSL window: the model retried blindly). In a remote window the extension now records what the window can still use when it writes subagents after the window opened: for a first setup nothing (work stays in the chat, the status bar reads **AI Cost: reload to finish**, routing starts after one reload); for a re-map the previous names, kept as alias files on the model the window loaded them with (so cards and estimates stay honest), with the new mapping applying after a reload. Should the Task tool still reject a name, its own error is turned into a one-time retry hint. Verified live in a WSL window: no failed subagent card in either case.
- The tier picker listed every effort level and fast variant of a model as its own row (a real account: eight rows all named "GPT-5.3 Codex"); it now shows each model once, on its plain id, cheapest first.
- The chat panel Cursor opens with the window never receives a `sessionStart` hook (Cursor 3.13 to 3.17, verified in the IDE), so the first chat most users type into had no routing rule at all: the model did the work itself, with no subagent and no savings. That chat is now briefed on its first prompt (`beforeSubmitPrompt` returns the same context sessionStart would have), once per conversation.
- A project that still carried project-scope files from an earlier version or a chat-driven setup (`.cursor/hooks.json` entries, `.cursor/cco-hook.mjs`, `.cursor/agents/cco-*.md`, `.cursor/cco/`) ran a second copy of the hooks and older subagents next to Everywhere. The repair pass now removes those files, once, when Everywhere covers the project.
- Reinstalling the same version with a different bundled hook binary (a rebuilt VSIX) left the old copy running; the repair pass compares the two and refreshes the copy. Pre-0.3 subagent files under `~/.cursor/agents` are replaced the same way.
- The Get Started page is rendered once per session by Cursor, so it showed the mapping from before activation, and kept it after **Choose tier models**. The page now switches to a freshly written copy whenever the mapping changes (verified: the table updates the moment the picker closes).
- "Turning on…" progress moved from a notification to the status bar; no toast is shown at install.
- The tool gate's post-delegation advice still mentioned a footer; the picker described models by raw id (`cursor-grok-4.6-high`) instead of their price (`$0.5/M in · $2.5/M out`).
- Fresh IDE-only users (no logged-in Cursor CLI) ended up with every tier on `inherit`, i.e. no savings: setup probed each candidate through the CLI, every probe failed with "authentication required", and all candidates were discarded. Probing is skipped when the model list itself came from the bundled catalogue, and an account-level probe failure stops probing and keeps the ranked candidates unverified. Found in a fresh-user UI run on Cursor 3.17.
- **Pause / Resume in This Project** only silenced the hooks; the routing rule and the user-level subagents still delegated, and the chat then invented a cost footer. A paused project now tells the chat to work normally and turns `cco-*` delegations back into in-chat work.
- Chat start waited on the network: the `sessionStart` hook refreshed the price table inline (20 s behind a blackholing proxy) and ran `cursor-agent --version` on every chat (0.65 s). Refreshes now run in a detached worker; the CLI version is cached per binary identity; chat start answers in about 0.1 s.
- A tier model at its usage limit (seen with Opus on a Pro account) failed every DEEP task the same way; the model is now put on a 6-hour cooldown, delegations step down a tier with a one-line note, and the chat finishes the task itself when nothing lower is usable.
- Honest footers: when the chat never delegated (escape hatch) or a subagent died, the hook now gives the exact in-chat footer instead of letting the model name a model it never used.
- A model the account keeps refusing (three refusals across 12+ hours: a plan or team restriction, or a disabled model) is dropped from the tier candidates and the tier is re-mapped at once; a usage limit stays a 6-hour cooldown with a step-down. Limits are shared by all projects.
- In Everywhere the compiled hook had no pointer to the full plugin, so it ran without config defaults: no cost estimates, no savings figure, no agent templates for re-maps. `plugin-path.txt` is now written next to the binary.
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
- Inner workings to the first-party bar: no synchronous child processes on the extension host (setup, repair, pause and removal are async), activation work deferred 1.5 s, a self-check that runs the real hook command once per activation and turns the hooks off with one message if it fails, a **Emergency stop** kill switch, and tight per-call hook timeouts (a hung hook is killed after 7 s).
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
- Settings `costOptimizer.hookRuntime` and `costOptimizer.nodePath` (machine scope).
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
