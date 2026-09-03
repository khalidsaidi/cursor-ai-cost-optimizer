# AI Cost Optimizer

Routes each Cursor request to the cheapest tier that can do it well, runs that tier on a model chosen for quality first, and enforces the routing with hooks. Keep whatever chat model you like, including Auto.

## Installation

```
/add-plugin cursor-ai-cost-optimizer
```

Then, in a project, run `/cco-init` once. It takes a few seconds, writes only inside the project's `.cursor/` folder (see below), and maps tiers from your account's model list (or the bundled catalogue if the Cursor CLI is not installed). Start a new chat afterwards. Projects you did not enable are left completely alone: no files, no messages in the chat, no hooks.

## How it works

| Tier | Typical work | Default model (first available on your account) |
|---|---|---|
| FAST | quick answers, small edits, lookups | Composer 2.5 |
| BALANCED | features, bug fixes | Claude Sonnet 5 thinking |
| DEEP | risky, complex, multi-file, security, data | Claude Opus 5 thinking |

- The routing rule scores each request (complexity, risk, breadth, uncertainty, latency), picks a tier, and delegates to the matching `cco-*` subagent, which runs on its own model. One-sentence answers are given directly.
- Hooks keep it honest without getting in your way: every delegation is validated (risk ≥ 7 never runs FAST, risk ≥ 9 always runs DEEP, `[cco:*]` overrides win, mis-routed delegations are rewritten invisibly, decisions are logged). When the chat model starts doing work that should be routed, or re-verifies work a subagent already did, the hook attaches one line of advice to that tool call and lets it through; nothing is blocked by default. `"enforcement": {"mode": "strict"}` turns the advice into a refusal for teams that want it enforced. A tier that is not cheaper than the chat model stays in the chat; simple questions and tiny edits are done directly.
- Research is always cheap: a read-only `cco-explore` subagent on the FAST model does codebase exploration for any tier, and after a small read budget the hooks send a strong chat model's research there too, so a deep task keeps its judgment on the strong model without paying it to read the codebase. Independent subtasks are delegated in parallel.
- Every work delegation carries the project's acceptance test command; in the IDE a hook runs it after FAST/BALANCED edits (no model tokens) and reports `CCO-VERIFY: pass|fail`. FAST and BALANCED subagents stop early with `CCO-ESCALATE: <tier>` when a task exceeds their tier; on either signal the chat delegates once to the next tier. Per-tier failure rates learned from outcomes escalate a tier that keeps failing.
- Tiny one-file edits (a typo, a rename, a comment) and simple questions are done right in the chat; a subagent round trip is not worth it for those.
- Every task ends with a fixed footer in the style of Copilot's model line: `[cco: FAST → composer-2.5 • 0.1x of chat model • est. ~$0.03]` for routed work, or `[cco: DEEP in chat → claude-opus-5-thinking-high • 1x]` when the work rightly stays on your chat model. The routing notice above it reads `CCO: FAST tier → composer-2.5 · est. ~$0.03 instead of ~$0.31 · about 10× cheaper per token than claude-opus-5-thinking-high`. `/cco-report` totals the estimated savings per project.
- Optional per-chat budget (`budget.sessionUsd` in `.cursor/cco.json`): a warning at 80%, and with `budget.enforce` routing is forced to FAST beyond 2× the budget unless you override.

## Components

| Type | Name | Purpose |
|---|---|---|
| Rule | `cco-routing` | routing protocol (always applied) |
| Agents | `cco-fast`, `cco-balanced`, `cco-deep`, `cco-verifier`, `cco-explore` | tier subagents, a read-only verifier, and a read-only explorer; `/cco-init` writes copies with real models into `.cursor/agents/` |
| Skills | `cco-init`, `cco-model-config`, `cco-report` | setup (user-invoked), model mapping, decision report |
| Commands | `/cco`, `/cco-init`, `/cco-models`, `/cco-report`, `/cco-doctor`, `/cco-off`, `/cco-on`, `/cco-uninstall`, `/cco-benchmark` | help, model choice, report with estimated savings, health check, off/on per project, real benchmark (asks first; costs usage) |
| Hooks | `workspaceOpen`, `sessionStart`, `beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `subagentStop`, `beforeShellExecution`, `sessionEnd` | discovery refresh, routing enforcement, learning, logging |

## Configuration (`.cursor/cco.json`)

```json
{
  "enabled": true,
  "modelOverrides": { "fast": "", "balanced": "", "deep": "" },
  "modelOverridePolicy": "best_effort",
  "pricing": { "plan": "pro" },
  "thresholds": { "fastMax": 3.4, "balancedMax": 6.4 },
  "guardrails": { "riskNoFast": 7, "riskForceDeep": 9 },
  "enforcement": { "mode": "advise", "requireDelegation": "auto", "minSavingsFactor": 1.3, "relayOnly": true, "maxDenialsPerConversation": 2 },
  "shellGuard": { "enabled": false },
  "budget": { "sessionUsd": 0, "warnAtFraction": 0.8, "enforce": false }
}
```

- `enforcement.mode`: `advise` (default: advice is attached to tool calls, nothing is blocked) or `strict` (the advice becomes a refusal, with an escape hatch after `maxDenialsPerConversation`).
- `enforcement.requireDelegation`: `auto` (router mode when the chat model costs ≥ `minSavingsFactor`× the FAST tier; otherwise only high-risk work is redirected), `always`, or `never`. `relayOnly: false` lets the chat model keep using tools after a delegation.
- `discovery.tierPreferences` (see `config/defaults.json`): ordered regex lists per tier; the first available, runnable match wins, price breaks ties.
- `pricing.plan`: `teams`/`enterprise` adds the $0.25/M Cursor Token Rate for third-party models to estimates.
- `shellGuard.enabled`: opt-in blocker for a short list of destructive shell commands.
- Overrides per request: `[cco:fast]`, `[cco:balanced]`, `[cco:deep]`, `[cco:auto]`, `[cco:off]`.

## What CCO writes on your machine

Only inside the project where you ran `/cco-init`:

| Path | What |
|---|---|
| `.cursor/hooks.json`, `.cursor/cco-hook.mjs` | CCO's hook entries (merged with yours; the IDE reads project hooks) and the small shim they run; commit both together, the shim is a no-op for teammates without the plugin |
| `.cursor/agents/cco-*.md` | five subagent files with the mapped `model:` (generated marker; your own files are never overwritten) |
| `.cursor/cco.json` | settings; created only when you change one (`/cco-models`, `/cco-off`) |
| `.cursor/cco/` | model mapping, price cache, decision and hook logs (scores only, never prompt text); ignores itself in git |

Nothing is written outside the project. Remove everything with `/cco-uninstall`, or turn it off with `/cco-off`. If you remove the plugin from Cursor without uninstalling per project, the leftover shim removes its own hook entries and itself the first time it runs, so nothing lingers.

## Network access and data

CCO sends no telemetry. It makes exactly two kinds of network calls, both through your own account and configuration:

| Call | When | What is sent |
|---|---|---|
| `GET https://cursor.com/docs/models-and-pricing.md` | setup, then at most daily | nothing (public page fetch) |
| `cursor-agent models` | setup, daily refresh of the model list | nothing (lists models) |
| probe requests ("Reply with exactly this text"), one per candidate model | only with `/cco-init --probe` or `/cco-models` | the probe prompt; billed like any request |

Local data: `.cursor/cco/state/decisions.jsonl` and `hooks.jsonl` hold routing scores, tool names, model ids and cost estimates, never prompt text or file contents; delete the folder at any time. Subagent sessions started by CCO are ordinary Cursor requests under your account and appear in Cursor's own usage dashboard.

Requirements: Node.js 18+ on PATH (hooks run `node`). The Cursor CLI (`cursor-agent`) is optional: with it, tiers are mapped from your account's real model list; without it, from the bundled catalogue. In the interactive CLI, add `node` (and your test runner) to the command allowlist or run with `--force`, otherwise each subagent command asks for approval. The Open VSX extension in this repository ships a self-contained hook binary per platform for machines without Node.

## Pricing data

Per-model rates are parsed from `https://cursor.com/docs/models-and-pricing.md` (input, cache write, cache read, output; fast variants priced 2×). A snapshot ships in `config/pricing.json` and is refreshed daily.

## Verification

```bash
node --test test/                                            # unit tests, no network
node scripts/cco-e2e-real.mjs --workspace .                  # real Cursor calls in temporary workspaces
node scripts/cco-benchmark.mjs --workspace . --repeats 1     # real usage-priced benchmark
```

Measured results and platform findings are in the repository README.

## License

MIT
