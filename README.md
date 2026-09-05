# cursor-ai-cost-optimizer

A Cursor Marketplace repo containing one plugin, **AI Cost Optimizer (CCO)**, plus an Open VSX extension that installs the same assets without the marketplace.

CCO routes each request to the cheapest effort tier that can do it well (FAST / BALANCED / DEEP), runs that tier on its own model through Cursor subagents, and enforces the routing with hooks so savings do not depend on the chat model remembering a rule.

- Plugin docs: [`plugins/cursor-ai-cost-optimizer/README.md`](plugins/cursor-ai-cost-optimizer/README.md)
- Extension: [`extensions/cursor-ai-cost-optimizer-vsx/`](extensions/cursor-ai-cost-optimizer-vsx/)
- Changelog: [`plugins/cursor-ai-cost-optimizer/CHANGELOG.md`](plugins/cursor-ai-cost-optimizer/CHANGELOG.md)

## What actually happens

| Mechanism | Where | Verified against cursor-agent 2026.08.31 |
|---|---|---|
| Tier subagents run on real models | `.cursor/agents/cco-*.md` written by setup with `model:` | Task tool shows the subagent's model; plugin-provided agents always inherit; `~/.cursor/agents` is not loaded by the CLI |
| Delegation guard | `preToolUse` hook on Task, `updated_input` | reroutes `subagent_type`; the rewritten agent's model is used |
| Tool gate | `preToolUse` hook from the project's `.cursor/hooks.json` (the IDE ignores plugin-declared hooks) | parent conversation redirected; subagent conversations untouched; inert in projects not set up |
| Session context | `sessionStart.additional_context` | mapping + prices visible to the model |
| Real cost accounting | `stream-json` `result.usage` × published per-model rates | input/output/cache read/cache write tokens |

## What a user sees

Install, one toast: "AI Cost Optimizer can send routine work to cheaper models and show what it saves. Turn it on for Cursor?" **Turn on** takes a few seconds and answers with "AI Cost Optimizer is on. Fast → Composer 2.5 · Balanced → Claude Sonnet 5 · Deep → Claude Opus 5. Start a new chat." (**Undo** is right there). No reload, nothing written into any project. From then on the status bar reads `⚡ Saved $4.12`.

In chat, on Auto or any model: the request, a subagent card whose line reads `Fast on Composer 2.5 · ~$0.02, saves ~$0.04`, the answer, and one closing line `Cost Optimizer · Fast on Composer 2.5 · ~$0.02, saves ~$0.04`. Risky work reads `Risky or complex change: routing to Deep (Claude Opus 5)`. When a task rightly stays in chat the line is `Cost Optimizer · done in chat on Grok 4.6`. Nothing else appears: no jargon, no reminders, no configuration.

## Measured results (maintainer's account, Pro plan, 2026-09-02)

Real `cursor-agent` runs, cost = CLI-reported tokens × Cursor's published per-model rates, quality = deterministic checks (tests pass, files exist). Tier models discovered: fast = Composer 2.5, balanced = Claude Sonnet 5 thinking, deep = Claude Opus 5 thinking. Quality was 100% for every policy in every run.

**Model for model** (the same task run directly on the tier model instead of Opus 5): 48–52% cheaper across three runs of 6–7 tasks; 81–93% median per task.

**Inside a chat whose model is Opus 5** (the chat model's routing turn plus the full subagent session, warm context): +15% on one run of toy tasks, −22% on a second, −65% on two real-codebase tasks. Reason: Opus finished each of those tasks in one or two turns, and CCO's routing turn is itself an Opus turn; the deep tier is the same model and is kept in the chat by design. Delegating from a frontier chat model only pays on work that would take that model many turns.

What this means for a user who wants to spend less:
- The savings come from running the work on the cheaper model end to end. With Auto or a cheap chat model, CCO's job is to guarantee the strong model on risky or complex work and the cheap one everywhere else, with every decision logged.
- With a frontier chat model, CCO gives explicit tiers and telemetry, but do not expect it to cut the bill on small tasks; the chat model's own turns dominate.

Reproduce (costs usage):

```bash
node plugins/cursor-ai-cost-optimizer/scripts/cco-e2e-real.mjs --workspace .
node plugins/cursor-ai-cost-optimizer/scripts/cco-benchmark.mjs --workspace . --repeats 1 --include-overhead
```

Reports: `.ai/cco/e2e-real-report.md`, `.ai/cco/benchmark-report.md`.

## Repository structure

- `.cursor-plugin/marketplace.json` — marketplace manifest
- `plugins/cursor-ai-cost-optimizer/` — the plugin (rules, agents, skills, commands, hooks, scripts, config, tests)
- `extensions/cursor-ai-cost-optimizer-vsx/` — VS Code / Open VSX extension mirroring the plugin assets
- `scripts/validate-template.mjs` — marketplace layout validator
- `docs/add-a-plugin.md` — how to add another plugin to this repo

## Validate locally

```bash
node scripts/validate-template.mjs
node --test plugins/cursor-ai-cost-optimizer/test/*.test.mjs
```

## What it does to your Cursor

- The extension's default setup ("Everywhere") writes nothing into any project: CCO entries in `~/.cursor/hooks.json`, five subagents in `~/.cursor/agents/`, state in the extension's storage, and the routing rule handed to Cursor per workspace via `workspaceOpen.pluginPaths`. Pause per project; Remove or uninstall leaves nothing behind.
- "This project only" (the marketplace plugin's `/cco-init`, or the extension's second option) writes 8 files under the project's `.cursor/` plus a git-ignored state folder, after you confirm the list. Commit them for teammates or ignore `.cursor/`. Projects you did not set up are untouched.
- Per-call overhead: one hook process per tool call, 44 ms with Node and 37 ms with the compiled binary (measured on this machine). Nothing is blocked by default.
- Failure behavior, measured in Cursor 3.17 from its own hooks log: a hook command that cannot start fails in about 30 ms and Cursor proceeds with no visible error; a hung hook is killed at the entry's timeout (5 s for per-call events) and Cursor proceeds. The extension also self-checks its hook once per activation and turns the hooks off if the check fails.
- Chat start never waits on the network or on CLI startup: the `sessionStart` hook answers from cache in about 0.1 s (it was 0.8 s, and up to 20 s behind a blackholing proxy); stale price tables and model maps are refreshed by a detached worker.
- Without a logged-in Cursor CLI (most IDE users) the tiers are mapped from the bundled catalogue unverified (FAST composer-2.5, BALANCED Sonnet, DEEP Opus); Cursor applies the account's own access rules when a subagent runs. A logged-in CLI verifies each model at setup.
- Pause really stops routing: a paused project's chat is told to work normally and any `cco-*` delegation is turned back into in-chat work (the rule and the subagents are user-level, so they cannot be unloaded per project).
- Usage limits: a tier model that refuses to start a subagent (typically a plan usage limit) is skipped for 6 hours and delegations step down a tier with a one-line note; when nothing lower is usable the chat finishes the task itself and says so.
- Removal takes everything back out and keeps other tools' hook entries.

## Platform coverage

The extension ships one VSIX per target: Linux x64, Linux ARM64, Windows x64, Windows ARM64, macOS Intel and macOS Apple Silicon. CI builds the hook binary natively on a GitHub-hosted runner of each platform, runs the plugin unit tests, the extension unit tests (including the compiled binary), real hook payloads through the binary, the VS Code integration suite, packages the VSIX with `--target`, and installs it into a downloaded VS Code to prove it is installable there. The plugin's own test job additionally runs the project-local install, a hook call through the committed shim, and the uninstall on all six runners. Locally, `npm run package:all` cross-compiles all six binaries with Bun and packages all six VSIX.

## Live runs on real Cursor

- **macOS**: the `Live Cursor on macOS` workflow (label a PR `live-macos`, or dispatch it) installs the real Cursor CLI on a macOS runner with a `CURSOR_API_KEY` secret, runs the six usage-priced end-to-end scenarios and a user-scope session (hooks in `~/.cursor`, nothing in the repo). Last full pass: 6/6, hooks fired. The run on 2026-09-04 scored 4/6 because the maintainer's account had hit its Opus usage limit mid-run (the condition the cooldown above now handles); re-run once the limit resets.
- **Windows**: native Windows Cursor, installed from the Windows x64 VSIX into a throwaway profile and driven through the real command palette by a PowerShell harness. Verified setup, hooks, plugin path after reload, and delegation.
- **Real-usage campaign on Cursor 3.17.21 (2026-09-04)**: a fresh user with an empty `~/.cursor` and no Cursor CLI login, driven through the real UI (palette, status menu, native dialogs, Extensions view) and Cursor's `prompt` deeplink. Exercised: install, Set Up Everywhere, the reload, delegation, `[cco:deep]` override, Pause and Resume, Remove, uninstalling the extension (its uninstall hook runs on the next Cursor start and leaves nothing), updating 0.2.0 → 0.2.1 (hooks repointed on activation, the old folder still served the startup hooks), Ask mode, and DEEP/BALANCED models at their usage limit. Gaps it found are fixed in this branch: all tiers fell back to `inherit` for users without a CLI login (no savings at all), Pause did not stop routing, chat start blocked on the network, a refused tier model failed the same way on every task, and the chat invented cost footers naming models it never used. Platform fact recorded on the way: Cursor 3.13–3.17 never emits `postToolUse` for the `Task` tool; `subagentStop` is the only completion signal for a delegation.
- **Older Cursor versions**: `extensions/cursor-ai-cost-optimizer-vsx/scripts/proof-cursor-linux.sh <version> <AppImage url>` runs an extracted Linux build under WSLg or any X11 display with the Everywhere setup, submits an edit task through Cursor's own `prompt` deeplink, and reads Cursor's hooks log. Verified on 3.13.25 and 3.15.19 (the oldest supported build and the one before the current line): the routing rule loaded through `workspaceOpen` plugin paths, the chat model's first action was a `Task` call to `fast-tier`, the subagent ran on composer-2.5, `subagentStop` reported completed, and the closing line named the Fast tier on composer-2.5. 3.16.29 and 3.17.x passed the same flow earlier.

## Marketplace readiness

In Cursor, install the official **create-plugin** plugin and run its **review-plugin-submission** skill on this repo before submitting.
