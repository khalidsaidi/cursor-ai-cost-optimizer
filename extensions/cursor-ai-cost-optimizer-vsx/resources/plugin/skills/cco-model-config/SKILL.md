---
name: cco-model-config
description: Guided mapping of CCO tiers (fast/balanced/deep) to real Cursor models via .cursor/cco.json (adaptive, fixed, or manual), then re-run discovery.
---

# cco-model-config

## Agent instructions
- Work from the workspace root; `<plugin>` is the folder containing `scripts/cco-discover-models.mjs`.
- Run discovery first and read the result:
  ```bash
  node <plugin>/scripts/cco-discover-models.mjs --workspace .
  ```
- Ask ONE question with numbered options:
  1. **Adaptive (recommended)**: set `modelOverrides.fast/balanced/deep` to `""` in `.cursor/cco.json`.
  2. **Fixed**: copy `profiles.fast.model`, `profiles.balanced.model`, `profiles.deep.model` from `.cursor/cco/runtime.json` into `modelOverrides`.
  3. **Manual**: ask for one model ID per tier. Validate each against `discovery.availableModels` in `.cursor/cco/runtime.json`; if invalid, ask once more, then leave that tier empty.
- Set `modelOverridePolicy` to `best_effort` unless the user explicitly wants `strict` (strict falls back to `inherit` instead of another model when an override is unavailable).
- Preserve unrelated keys in `.cursor/cco.json`.
- Re-run discovery so the plugin's tier subagents are remapped, then show the final mapping, prices, and `health.notes`.
- Mention that the user can verify end to end with:
  ```bash
  node <plugin>/scripts/cco-e2e-real.mjs --workspace .
  ```
  (this makes real Cursor calls).
