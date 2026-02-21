---
name: cco-report
description: Summarizes routing decisions from .ai/cco/decisions.jsonl and suggests tuning thresholds/weights to save more cost.
metadata:
  author: Khalid Saidi
  version: 0.1.0
---

# cco-report

## What this does
- Reads `.ai/cco/decisions.jsonl` (if present) and summarizes:
  - count of FAST vs BALANCED vs DEEP
  - common reasons/risk flags
  - suggested config tuning ideas

## Agent instructions
- If the log file doesn’t exist, explain how to enable telemetry (cco-routing rule best-effort logging) and suggest running a few tasks first.
- Keep report short and actionable.
- Read `.cursor/cco.json` when available (fallback: `plugins/cursor-ai-cost-optimizer/config/defaults.json`) before suggesting tuning.
- Suggest ONE change at a time and base it on current values (for example: `risk` 0.35 -> 0.30), never on assumed placeholder values.
