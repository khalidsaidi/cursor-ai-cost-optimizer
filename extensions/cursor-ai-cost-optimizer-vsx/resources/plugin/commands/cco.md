---
name: cco
description: Help and quickstart for AI Cost Optimizer (how routing works, override tokens, setup, reports).
---

# /cco — AI Cost Optimizer

CCO routes each request to the cheapest tier that can do it well, and runs that tier on its own model:

| Tier | Typical work | Model (after setup) |
|---|---|---|
| FAST | quick answers, small edits, lookups | Composer 2.5 (cheap, strong at code) |
| BALANCED | normal features and bug fixes | Claude Sonnet 5 thinking |
| DEEP | risky, complex, multi-file, security, data | Claude Opus 5 thinking |

Two enforcement points make this deterministic instead of "hope the model delegates":
- **Task guard**: every `cco-*` delegation is scored; risk guardrails can re-route it up a tier; the decision is logged.
- **Tool gate**: with an expensive chat model, only the Task tool is allowed until the work is delegated, and only relaying is allowed afterwards; with a cheap chat model, only high-risk work is redirected up. Subagents are never gated. Write `[cco:off]` in a prompt to work directly.

## Setup (once per workspace)
1. Run the `cco-init` skill (or just start chatting: the routing rule runs the setup itself the first time it notices CCO is not enabled). It writes CCO's hooks, the tier subagents (quality first: Composer 2.5 / Sonnet 5 / Opus 5 by default), settings and a small state folder under the project's `.cursor/`, and probes which models your account can run. Nothing is written outside the project.
2. Start a new chat. Keep whatever chat model you prefer; with a frontier chat model CCO switches to router mode (the chat model only classifies and relays), with a cheap one it only escalates risky work.

## Everyday use
- Just work. Prefix a prompt with `[cco:fast]`, `[cco:balanced]`, or `[cco:deep]` to force a tier, `[cco:auto]` to reset, `[cco:off]` to bypass CCO for that request.
- `/cco-report` summarizes decisions, estimated savings, denials, and learning state, with tuning suggestions.
- `/cco-doctor` checks the setup; `/cco-off` and `/cco-on` toggle CCO for this project.
- `/cco-benchmark` runs a real, usage-priced benchmark (costs real usage).

## Files (all inside the project's `.cursor/` folder)
- `.cursor/cco.json` — settings for this project (model overrides, thresholds, enforcement mode, `"enabled": false` to turn off)
- `.cursor/agents/cco-*.md` — the tier subagents (the only place Cursor honors a subagent model)
- `.cursor/hooks.json` — CCO's hook entries (merged with yours)
- `.cursor/cco/` — hook shim, model mapping, price cache, decisions and hook logs (scores only, no prompt text; gitignore if you like)
