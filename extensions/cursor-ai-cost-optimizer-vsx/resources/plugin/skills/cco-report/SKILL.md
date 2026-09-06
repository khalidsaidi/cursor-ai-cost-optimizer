---
name: cco-report
description: Summarize CCO routing decisions, gate denials, models, and learning state; suggest one tuning change based on real numbers.
---

# cco-report

## Agent instructions
- Run from the workspace root (`<plugin>` = folder containing `scripts/cco-report.mjs`):
  ```bash
  node <plugin>/scripts/cco-report.mjs --workspace .
  ```
- Show the output as-is.
- If it lists suggestions, offer to apply ONE of them to `.cursor/cco.json` (state the current value and the new value, e.g. `thresholds.fastMax 3.4 → 3.9`). Never change more than one knob at a time.
- If there is no activity yet, explain that decisions are logged automatically once the plugin's hooks run (delegations to `cco-*` subagents and tool-gate checks) and suggest running a few tasks first.
