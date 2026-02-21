# cursor-ai-cost-optimizer

A **Cursor Marketplace plugin repo** containing a single plugin:

- `cursor-ai-cost-optimizer` — **AI Cost Optimizer** (fuzzy-logic router that chooses FAST/BALANCED/DEEP effort and routes to the right subagent)

## Repository structure
This repo uses Cursor’s multi-plugin marketplace layout (even though it contains just one plugin):
- `.cursor-plugin/marketplace.json` — lists plugins
- `plugins/cursor-ai-cost-optimizer/.cursor-plugin/plugin.json` — per-plugin manifest
- plugin components live under `plugins/cursor-ai-cost-optimizer/`

## Validate locally
```bash
node scripts/validate-template.mjs
```

## Marketplace readiness checks (recommended)
In Cursor, install the official **create-plugin** plugin and run its submission review on this repo:
- `/add-plugin create-plugin`
- run **review-plugin-submission** on this workspace (see instructions printed at the end of the runbook)

