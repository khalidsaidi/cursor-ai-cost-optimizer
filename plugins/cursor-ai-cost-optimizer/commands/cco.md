---
name: cco
description: Help + quickstart for AI Cost Optimizer (routing tiers, override tokens, and how to initialize config).
---

# /cco — AI Cost Optimizer Help

## What it does
AI Cost Optimizer auto-selects an effort tier (FAST / BALANCED / DEEP) using fuzzy logic and routes work to the right subagent.

## Override tokens
Add any token anywhere in your prompt:
- **[cco:fast]** — force cheapest/quickest
- **[cco:balanced]** — force default
- **[cco:deep]** — force thorough
- **[cco:auto]** — let the router decide (default)

## Setup (recommended)
Run the skill **cco-init** to create:
- `.cursor/cco.json` (tuning weights/thresholds)
- `.ai/cco/` (decision logs)

Then use the tool normally; routing should happen automatically.

## Tip
If you notice it’s going “DEEP” too often, run **cco-report** and tune thresholds.
