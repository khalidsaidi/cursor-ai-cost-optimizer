---
name: cco
description: Help and quickstart for AI Cost Optimizer (how routing works, override tokens, setup, reports).
---

# /cco — AI Cost Optimizer

CCO sends each task to the cheapest tier that can do it well, and runs that tier on its own model:

| Tier | Typical work | Model (after setup) |
|---|---|---|
| FAST | quick answers, small edits, lookups | Composer 2.5 (cheap, strong at code) |
| BALANCED | normal features and bug fixes | Claude Sonnet 5 thinking |
| DEEP | risky, complex, multi-file, security, data | Claude Opus 5 thinking |

How it stays honest without getting in your way:
- Every `cco-*` delegation is checked by a hook: risk guardrails can move it up a tier, mis-routed delegations are rewritten, and each decision is logged.
- When the chat model starts doing work that should be routed, the hook attaches one line of advice to that tool call and lets it through. Nothing is blocked by default.
- Two things are enforced: your explicit `[cco:<tier>]` token, and risky work on a cheap chat model (it goes to the strong tier). `"enforcement": {"mode": "strict"}` in `.cursor/cco.json` enforces cost routing too.
- Subagents are never gated. `[cco:off]` in a prompt bypasses CCO for that request.

## Setup (once per project)
1. Run `/cco-init` (or the extension's **Set Up / Update in This Workspace**). It writes CCO's hook entries, a small hook shim, the tier subagents and a state folder under the project's `.cursor/` and maps the tiers to models your account can run. Nothing is written outside the project, and nothing happens in projects you did not set up.
2. Start a new chat and keep whatever chat model you prefer. With a frontier chat model CCO delegates the work and relays the result; with a cheap one it only escalates risky work.

## Everyday use
- Just work. Each routed task ends with a line like `[cco: FAST → composer-2.5 • 0.3x of your chat model • est. $0.02]`.
- Prefix a prompt with `[cco:fast]`, `[cco:balanced]` or `[cco:deep]` to force a tier, `[cco:auto]` to reset, `[cco:off]` to bypass CCO for that request.
- `/cco-report` summarizes decisions, estimated savings and learning state. `/cco-models` changes the tier models. `/cco-doctor` checks the setup. `/cco-off` and `/cco-on` pause and resume CCO in this project. `/cco-uninstall` removes everything CCO wrote.
- `/cco-benchmark` runs a real, usage-priced benchmark (costs real usage; it asks first).

## Files (all inside the project's `.cursor/` folder)
- `hooks.json` + `cco-hook.mjs` — CCO's hook entries (merged with yours) and the shim they run. Commit both; they are a no-op for teammates without the plugin.
- `agents/cco-*.md` — the tier subagents (the only place Cursor honors a subagent model).
- `cco/` — model mapping, price cache, decisions and hook logs (scores only, never prompt text). Ignores itself in git.
- `cco.json` — optional settings (model overrides, thresholds, enforcement mode, `"enabled": false`). Created only when you change a setting.
