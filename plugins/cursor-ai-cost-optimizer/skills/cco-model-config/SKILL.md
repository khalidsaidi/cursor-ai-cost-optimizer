---
name: cco-model-config
description: Guided configuration for mapping FAST/BALANCED/DEEP to real Cursor models in .cursor/cco.json.
metadata:
  author: Khalid Saidi
  version: 0.1.0
---

# cco-model-config

## What this does
1) Refreshes runtime model discovery (`.cursor/cco-runtime.json`).
2) Presents a user-friendly setup choice:
   - Adaptive (recommended for most users)
   - Fixed models
   - Manual (advanced)
3) Writes `.cursor/cco.json` model overrides.
4) Re-runs discovery and reports final mapping + warnings.

## Agent instructions
- Use workspace root.
- Ensure `.cursor/cco.json` exists (copy `plugins/cursor-ai-cost-optimizer/config/defaults.json` if missing).
- Run:
  - `node plugins/cursor-ai-cost-optimizer/scripts/cco-discover-models.mjs --workspace <workspace-root>`
- Read `.cursor/cco-runtime.json`.
- Ask one short question with numbered options:
  - 1) Adaptive (recommended): set `modelOverrides.fast/balanced/deep` to empty strings.
  - 2) Fixed models: copy `.cursor/cco-runtime.json` profile models into `modelOverrides`.
  - 3) Manual (advanced): let user choose model IDs for each mode from `discovery.availableModels`.
- For non-technical users, explicitly recommend option 1 unless they ask for stability/manual control.
- For custom:
  - Validate each selected model ID exists in `discovery.availableModels`.
  - If invalid, ask once for correction. If still invalid, leave that mode empty.
- Set `modelOverridePolicy` to:
  - `best_effort` unless the user explicitly asks for strict behavior.
- Preserve unrelated keys in `.cursor/cco.json`.
- Re-run discovery after writing config.
- Final output must include:
  - selected option
  - effective profile mapping (fast/balanced/deep from `.cursor/cco-runtime.json`)
  - health status (`health.degraded` + notes)
  - test command:
    - `node plugins/cursor-ai-cost-optimizer/scripts/cco-e2e-real.mjs --workspace <workspace-root>`
