---
name: cco
description: Help + quickstart for AI Cost Optimizer (routing tiers, override tokens, and how to initialize config).
---

# /cco — AI Cost Optimizer Help

## 30-second setup
1) Run `cco-init` once.
2) Run `/cco-models`.
3) Pick one option:
- **Adaptive (recommended for most users)**: CCO chooses models automatically as availability changes.
- **Fixed models**: save the current working model per mode and do not auto-change it.
- **Manual (advanced)**: choose exact model IDs yourself.

Done. Use CCO normally after that.

Most users should keep **Adaptive**.

## Optional prompt overrides
- `[cco:fast]`
- `[cco:balanced]`
- `[cco:deep]`
- `[cco:auto]`
