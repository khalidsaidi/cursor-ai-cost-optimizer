---
name: cco-report
description: Summarize CCO routing decisions, gate denials, tier models and learning state for this workspace, with tuning suggestions.
---

# /cco-report

Run:

```bash
node <plugin>/scripts/cco-report.mjs --workspace .
```

It reads this workspace's decisions, hook log, and learning state under `.cursor/cco/state/` plus the mapping in `.cursor/cco/runtime.json`, and prints:
- delegations per tier and how many were re-routed by policy (and why)
- tool-gate checks and denials (and why)
- the current tier→model mapping with prices
- per-tier error/rework EMAs used for automatic escalation
- one or two concrete tuning suggestions based on your actual numbers

Present the output to the user as-is, then offer to apply at most one suggested change to `.cursor/cco.json`.
