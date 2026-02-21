---
name: cco-models
description: Guided setup for mapping CCO modes (fast/balanced/deep) to real Cursor models.
---

# /cco-models - Configure Mode -> Model Mapping

Use this command when you want a user-friendly setup for which model each CCO mode should use.

## What this command should do
1) Run `cco-model-config`.
2) Show the user simple choices:
   - Auto (recommended): no pinning, let discovery choose.
   - Pin current mapping: lock current discovered fast/balanced/deep models.
   - Custom mapping: user selects exact model IDs for each mode.
3) Apply selection to `.cursor/cco.json`.
4) Re-run discovery and show final mapping + any health warnings.

## Files involved
- `.cursor/cco.json` (user config)
- `.cursor/cco-runtime.json` (discovered runtime mapping)
- `plugins/cursor-ai-cost-optimizer/scripts/cco-discover-models.mjs`

## Quick verify
```bash
node plugins/cursor-ai-cost-optimizer/scripts/cco-e2e-real.mjs --workspace .
```
