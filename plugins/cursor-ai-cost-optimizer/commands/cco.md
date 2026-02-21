---
name: cco
description: Help + quickstart for AI Cost Optimizer (routing tiers, override tokens, and how to initialize config).
---

# /cco — AI Cost Optimizer Help

## 30-second setup
1) Run `cco-init` once.
2) Run `/cco-models`.
3) Pick one option:
- **Automatic (recommended for most users)**: CCO chooses models automatically.
- **Locked (fixed until changed)**: save the current working model per mode and keep it fixed.
- **Manual (advanced)**: choose exact model IDs yourself.

Done. Use CCO normally after that.

Most users should keep **Automatic**.

## Optional prompt overrides
- `[cco:fast]`
- `[cco:balanced]`
- `[cco:deep]`
- `[cco:auto]`
