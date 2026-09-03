# Changelog

## 0.2.0 - 2026-09-02
Rebuilt around what the Cursor platform actually supports today (verified against `cursor-agent` 2026.08.31).

### Added
- User scope: `cco-init --scope user --state-root <dir>` (user-level hooks and subagents, private state root, runtime plugin via `workspaceOpen.pluginPaths`); hook commands carry `--scope/--state-root`.
- Install-impact pass to the Copilot bar: advise-first by default (cost routing is advice attached to tool calls; only explicit `[cco:<tier>]` overrides and quality escalations are enforced; `enforcement.mode: strict` enforces everything), no unsolicited chat messages in projects that are not enabled, a self-removing shim when the plugin is gone, and no settings file until a setting is changed.
- Second UX pass: `/cco-init` and `/cco-uninstall` are real slash commands; the hook shim sits next to `hooks.json` so committing hooks is safe for teammates (no-op without the plugin); tiny one-file edits stay in the chat; interactive CLI sessions detect new user turns from the transcript so per-turn state resets.
- UX friction pass: setup finishes in seconds (probing is opt-in via `--probe`) and prints a plain summary; works without the Cursor CLI (bundled catalogue, doctor explains how to install it); the state folder ignores itself in git; logs are bounded; the first routing notice of a session says how to force a tier; the not-enabled nudge is silent once a `.cursor/cco.json` exists.
- Copilot-style footer on every task (`[cco: FAST → composer-2.5 • 0.1x of chat model • est. ~$0.03]`, or `[cco: DEEP in chat → … • 1x]` when the work stays on the chat model); optional per-chat budget (`budget.sessionUsd`) with a warning at 80% and enforced FAST routing beyond 2×; a mechanically true "Network access and data" section in the README.
- UX: per-task cost estimate versus the chat model on every routing line; `/cco-report` totals estimated savings per project; `/cco-doctor` health check; `/cco-off` and `/cco-on`; the first-run nudge appears once per conversation and only for requests that would be routed.
- Step-level delegation: a read-only `cco-explore` subagent on the FAST model for research; the gate enforces a read budget (default 3) after which research on a big task must go to `cco-explore`, even when the edits rightly stay on the strong chat model. Independent subtasks are delegated in parallel. Every work delegation carries the project's acceptance test command (detected from package.json, node:test, pytest, cargo, go); in the IDE a hook runs it after FAST/BALANCED edits and reports `CCO-VERIFY: pass|fail`, escalating on failure. Each routing line shows a cost estimate for the task on the chosen tier.
- Project-local install, all under the project's `.cursor/`: `hooks.json` entries (merge-preserving, via a small shim in `.cursor/cco/` that locates the plugin so updates never break hooks), `agents/cco-*.md` (verified: plugin-provided agents always inherit the chat model and the CLI does not load `~/.cursor/agents`), `cco.json`, and `cco/` for mapping, price cache and logs. Nothing is written outside the project. Hooks are inert in projects that were not set up; `--disable`, `--enable`, `--uninstall`, per-request `[cco:off]`. No prompt text is stored.
- Tier subagents now run on real models: discovery writes `.cursor/agents/cco-{fast,balanced,deep,verifier}.md` with a concrete `model:` chosen from the models the account can run (ranked by capability class + price, probed, CLI default model restored afterwards).
- Deterministic enforcement hooks:
  - Task guard (`preToolUse` on Task): validates `CCO-SCORES`, applies guardrails and overrides, rewrites mis-routed delegations via `updated_input`, logs to `.ai/cco/decisions.jsonl`.
  - Tool gate (`preToolUse` on all tools): router mode for expensive chat models (only Task allowed before delegation, relay-only after it); lenient mode for cheap chat models (only high-risk work redirected up); a tier whose model is not materially cheaper than the chat model stays in the chat (a subagent is a fresh session that re-caches the whole system context, so same-model delegation only adds cost); subagents are never gated; escape hatch after two denials; `[cco:off]`.
  - `workspaceOpen` hook and first-prompt fallback for discovery (the IDE never sends a per-chat `sessionStart`; it reports the model as `default` on Auto, which CCO prices as Auto); Task guard denies delegations to tiers that are not cheaper than the chat model unless quality-driven.
  - Hook dispatcher is idempotent: the CLI runs plugin-declared and user-level hooks both, so duplicate deliveries of one event take an atomic lock and replay the first result.
  - Single hook dispatcher `scripts/cco-hook.mjs <event>` (basis for the extension's per-platform binaries); `CCO_PLUGIN_ROOT` override for relocated installs.
  - Outcome learning (`postToolUse` Task / `subagentStop`): per-tier error/rework EMAs drive automatic escalation; cascade nudges on `CCO-ESCALATE`.
  - Session context injection (`sessionStart.additional_context`) with the live tier→model mapping and prices.
- Per-model pricing from `cursor.com/docs/models-and-pricing.md` (cache read/write, fast 2×, optional Teams token rate) with a bundled snapshot.
- Real usage-priced benchmark (`scripts/cco-benchmark.mjs`) using the CLI's `usage` object, reporting fresh-session and warm-chat (cached context) costs plus the true in-chat CCO cost (routing turn + full subagent session); real e2e test (`scripts/cco-e2e-real.mjs`) that asserts delegation targets, subagent models, gate behavior, and overrides.
- `cco-init.mjs` one-shot setup and `cco-install-hooks.mjs` (merge-preserving user/project `hooks.json`; the IDE ignores plugin-declared hooks); the routing rule bootstraps itself on first use.
- `cco-report` script/command with tuning suggestions; 36 unit tests (`node --test test/`).

### Changed
- Routing rule rewritten (shorter, mandatory `CCO-SCORES` line, cascade + context-hygiene guidance).
- `cco-fast`/`cco-balanced` stop early with `CCO-ESCALATE: <tier>`; `cco-verifier` replies `CCO-VERIFY: pass|fail`.
- Quality-first tier preferences on the current catalogue: FAST = Composer 2.5, BALANCED = Claude Sonnet 5 thinking, DEEP = Claude Opus 5 thinking (then Grok 4.6, GPT-5.6 Sol/Terra, Gemini Flash as fallbacks); configurable via `discovery.tierPreferences`.
- Subagents return ≤150–250-word user-facing summaries so the chat model can relay them without re-reading; DEEP tier trimmed of planning ceremony.
- Probes use `--trust --mode ask` (read-only) instead of `-f`.
- Shell guard is opt-in (`shellGuard.enabled`).

### Removed
- `cco-router` subagent (the chat model routes; an extra hop only added cost).
- Pricing scraper for the removed "Auto API rates" section; LLM-computed joint-scoring formulas (now computed in hooks); the old chaos benchmark and its stale SVG dashboards.

### Known gaps
- Windows-native runs are covered by unit tests in CI only; no desktop verification yet.

## 0.1.3 - 2026-02-21
- Joint-scoring engine, chaos benchmark, `/cco-benchmark`, SVG dashboards.

## 0.1.2 - 2026-02-21
- `sessionStart` pricing refresh hook and configurable cost heuristics.

## 0.1.1 - 2026-02-21
- `/cco-models` command and `cco-model-config` skill.

## 0.1.0 - 2026-02-21
- Initial release: fuzzy routing rule + tiered subagents + init/report skills + optional hooks.
