# Changelog

## 0.1.3 - 2026-02-21
- Added real joint-scoring engine (`scripts/cco-joint-engine.mjs`) implementing:
  - `TotalLoss = wc*C_hat + wq*R_hat + wl*L_hat`
  - `C_hat = 0.6*C_price_prior + 0.4*C_field_proxy`
  - high-risk safety guard + adaptive weights + EMA online updates.
- Added real chaos benchmark runner (`scripts/cco-joint-chaos-real.mjs`) using isolated temp workspaces and real `cursor-agent` calls.
- Added `/cco-benchmark` command for running the benchmark and generating matrix reports.
- Added `jointScoring` defaults in config for user-tunable weights, priors, and guardrails.
- Added user-facing visual benchmark elements (SVG dashboard, SVG scenario map, SVG top-10 savings board, Mermaid cost chart) in plugin docs.

## 0.1.2 - 2026-02-21
- Added `sessionStart` pricing refresh hook (`scripts/cco-session-start.mjs`) that ingests official Cursor pricing docs and writes `.cursor/cco-pricing.json`.
- Added configurable pricing refresh settings in `config/defaults.json` (`pricing.enabled`, `pricing.refreshHours`, `pricing.sourceUrl`).
- Added configurable `costHeuristics` defaults (field weights, tier multipliers, tie-break margin) for pricing-aware routing decisions.
- Updated setup docs and `/cco` help text to explain pricing cache behavior.

## 0.1.1 - 2026-02-21
- Added user-friendly model configuration flow:
  - New command: `/cco-models`
  - New skill: `cco-model-config`
- Updated docs to direct end users to guided mode-to-model setup.

## 0.1.0 - 2026-02-21
- Initial release: fuzzy routing rule + tiered subagents + init/report skills + optional hooks.
