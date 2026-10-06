---
name: cco-doctor
description: Check that AI Cost Optimizer is healthy in this project (hooks, tier agents, model mapping, price cache) and say how to fix anything missing.
---

# /cco-doctor

Run from the project root (`<plugin>` is the folder containing `scripts/cco-doctor.mjs`):

```bash
node <plugin>/scripts/cco-doctor.mjs --workspace .
```

Show the output as-is. If anything is ❌, the fix is almost always `/cco-init`; for `inherit` tiers suggest `/cco-models`.
