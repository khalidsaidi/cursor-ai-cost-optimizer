---
name: cco
description: Help + quickstart for AI Cost Optimizer (routing tiers, override tokens, and how to initialize config).
---

# /cco — AI Cost Optimizer Help

## What it does
AI Cost Optimizer auto-selects an effort tier (FAST / BALANCED / DEEP) using fuzzy logic and routes work to the right subagent.
It also supports runtime model discovery so each tier maps to models that actually work in your current Cursor account/session.

## Override tokens
Add any token anywhere in your prompt:
- **[cco:fast]** — force cheapest/quickest
- **[cco:balanced]** — force default
- **[cco:deep]** — force thorough
- **[cco:auto]** — let the router decide (default)

## Setup (recommended)
Run the skill **cco-init** to create:
- `.cursor/cco.json` (tuning weights/thresholds)
- `.cursor/cco-runtime.json` (discovered real model mapping for fast/balanced/deep)
- `.ai/cco/` (decision logs)

For user-friendly model setup, run **/cco-models**.
It provides a guided flow for:
- Auto mapping (recommended)
- Pin current discovered mapping
- Custom model per mode

Advanced users can still edit `.cursor/cco.json` directly:
- `modelOverrides.fast`
- `modelOverrides.balanced`
- `modelOverrides.deep`
- `modelOverridePolicy`: `best_effort` or `strict`

Then use the tool normally; routing should happen automatically.

## Verify real Cursor behavior
```bash
node plugins/cursor-ai-cost-optimizer/scripts/cco-e2e-real.mjs --workspace .
```
This validates routing + discovered model mapping and writes `.ai/cco/e2e-real-report.md`.

## Tip
If you notice it’s going “DEEP” too often, run **cco-report** and tune thresholds.
