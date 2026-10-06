---
name: cco-init
description: Set up AI Cost Optimizer for this project (hooks, tier subagents with real models, settings), all inside .cursor/. Takes a few seconds.
---

# /cco-init

Run from the project root (`<plugin>` is the folder containing `scripts/cco-init.mjs`; under `~/.cursor/plugins/...` when installed from the marketplace):

```bash
node <plugin>/scripts/cco-init.mjs --workspace .
```

Show its plain-text output to the user as-is, then tell them to start a new chat (Cursor loads subagents at chat start). Do not add commentary beyond that.
