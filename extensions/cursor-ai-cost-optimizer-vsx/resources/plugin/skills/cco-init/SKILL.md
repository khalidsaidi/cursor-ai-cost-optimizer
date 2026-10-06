---
name: cco-init
description: Set up AI Cost Optimizer for this project (hooks, model discovery with probes, tier subagents with real models, price cache), all inside .cursor/.
disable-model-invocation: true
---

# cco-init

## What this does (everything inside the project's `.cursor/` folder)
1. Merges CCO's hook entries into `.cursor/hooks.json` and writes the hook shim to `.cursor/cco/`.
2. Caches Cursor's price table and maps tiers from `cursor-agent models` (bundled catalogue when the CLI is missing). `--probe` additionally verifies each tier model with a tiny request.
3. Writes `.cursor/agents/cco-{fast,balanced,deep,verifier,explore}.md` with the mapped `model:`.
4. Creates `.cursor/cco.json` for settings.

## Agent instructions
- `<plugin>` is the folder containing `scripts/cco-init.mjs` (under `~/.cursor/plugins/...` when installed from the marketplace; `plugins/cursor-ai-cost-optimizer` in this repo).
- Run once per project:
  ```bash
  node <plugin>/scripts/cco-init.mjs --workspace .
  ```
  (`--probe` verifies each tier model with a tiny request; `--disable`, `--enable`, `--uninstall` also exist). Show its plain-text output to the user as-is.
- Show the printed tier→model mapping and prices, and `notes` if degraded.
- Tell the user to start a new chat (Cursor loads subagents at chat start), that they keep their usual model, that each routed task shows a `CCO:` line with the tier, model, and price ratio, and that `.cursor/cco/` can be gitignored. Overrides: `[cco:fast]`, `[cco:balanced]`, `[cco:deep]`, `[cco:auto]`, `[cco:off]`.
