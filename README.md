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

In Cursor, on Auto or any model, in a real codebase: the request, one line like "routing this to the cheap tier", a `cco-fast` subagent card that completes, the answer, and a footer `[cco: FAST → composer-2.5]`. Risky work shows a `cco-deep` card on Opus 5 instead. No configuration beyond a one-time `cco-init` (the routing rule runs it itself on first use), and everything CCO writes stays inside the project's `.cursor/` folder. Verified by watching a real Cursor desktop session on 2026-09-02 (hooks, delegation, and files all confirmed on disk).

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

## Platform coverage

The extension ships one VSIX per target: Linux x64, Linux ARM64, Windows x64, Windows ARM64, macOS Intel and macOS Apple Silicon. CI builds the hook binary natively on a GitHub-hosted runner of each platform, runs the plugin unit tests, the extension unit tests (including the compiled binary), real hook payloads through the binary, the VS Code integration suite, packages the VSIX with `--target`, and installs it into a downloaded VS Code to prove it is installable there. The plugin's own test job additionally runs the project-local install, a hook call through the committed shim, and the uninstall on all six runners. Locally, `npm run package:all` cross-compiles all six binaries with Bun and packages all six VSIX.

## Marketplace readiness

In Cursor, install the official **create-plugin** plugin and run its **review-plugin-submission** skill on this repo before submitting.
