# cursor-ai-cost-optimizer

A **Cursor Marketplace plugin repo** containing a single plugin:

- `cursor-ai-cost-optimizer` — **AI Cost Optimizer** (fuzzy-logic router that chooses FAST/BALANCED/DEEP effort and routes to the right subagent)

## Repository structure
This repo uses Cursor’s multi-plugin marketplace layout (even though it contains just one plugin):
- `.cursor-plugin/marketplace.json` — lists plugins
- `plugins/cursor-ai-cost-optimizer/.cursor-plugin/plugin.json` — per-plugin manifest
- plugin components live under `plugins/cursor-ai-cost-optimizer/`

## Component coverage
- Rules: `plugins/cursor-ai-cost-optimizer/rules/cco-routing.mdc`
- Skills: `plugins/cursor-ai-cost-optimizer/skills/cco-init/SKILL.md`, `plugins/cursor-ai-cost-optimizer/skills/cco-model-config/SKILL.md`, `plugins/cursor-ai-cost-optimizer/skills/cco-report/SKILL.md`
- Agents: `plugins/cursor-ai-cost-optimizer/agents/cco-router.md`, `plugins/cursor-ai-cost-optimizer/agents/cco-fast.md`, `plugins/cursor-ai-cost-optimizer/agents/cco-balanced.md`, `plugins/cursor-ai-cost-optimizer/agents/cco-deep.md`, `plugins/cursor-ai-cost-optimizer/agents/cco-verifier.md`
- Commands: `plugins/cursor-ai-cost-optimizer/commands/cco.md`, `plugins/cursor-ai-cost-optimizer/commands/cco-models.md`, `plugins/cursor-ai-cost-optimizer/commands/cco-benchmark.md`
- Hooks: `plugins/cursor-ai-cost-optimizer/hooks/hooks.json`
- Pricing refresh: `plugins/cursor-ai-cost-optimizer/scripts/cco-session-start.mjs` (runs on `sessionStart`, caches `.cursor/cco-pricing.json`)
- Joint scorer + benchmark: `plugins/cursor-ai-cost-optimizer/scripts/cco-joint-engine.mjs`, `plugins/cursor-ai-cost-optimizer/scripts/cco-joint-chaos-real.mjs`

## Real benchmark highlight
Latest real chaos benchmark (February 21, 2026, 24 paired runs):
- Estimated cost: `$0.194389` -> `$0.041031` (`78.89%` reduction)
- Quality pass rate preserved: `75.00%` baseline vs `75.00%` joint
- Avg `duration_api_ms`: `14379.7` -> `5466.8`

Visual summary:
- `plugins/cursor-ai-cost-optimizer/assets/benchmark-dashboard.svg`
- `plugins/cursor-ai-cost-optimizer/assets/benchmark-scenario-map.svg`
- `plugins/cursor-ai-cost-optimizer/assets/benchmark-top10-savings.svg`

## Validate locally
```bash
node scripts/validate-template.mjs
```

## Real Cursor Model Discovery
To map CCO tiers to models that are actually runnable for the current user/session:
```bash
node plugins/cursor-ai-cost-optimizer/scripts/cco-discover-models.mjs --workspace .
```
This writes `.cursor/cco-runtime.json` with discovered `fast`/`balanced`/`deep` model mappings.

To run real Cursor end-to-end checks (discovery + router behavior):
```bash
node plugins/cursor-ai-cost-optimizer/scripts/cco-e2e-real.mjs --workspace .
```
This writes `.ai/cco/e2e-real-report.md` and `.ai/cco/e2e-real-report.json`.

To run the joint-scoring chaos benchmark (real Cursor calls in isolated tmp workspace):
```bash
node plugins/cursor-ai-cost-optimizer/scripts/cco-joint-chaos-real.mjs --workspace . --repeats 2
```
This writes `.ai/cco/joint-chaos-real-report.md` and `.ai/cco/joint-chaos-real-report.json`.

User-friendly model setup is available via `/cco-models`:
- Adaptive (recommended for most users)
- Fixed models
- Manual (advanced)

## Marketplace readiness checks (recommended)
In Cursor, install the official **create-plugin** plugin and run its submission review on this repo:
- `/add-plugin create-plugin`
- run **review-plugin-submission** on this workspace (see instructions printed at the end of the runbook)
