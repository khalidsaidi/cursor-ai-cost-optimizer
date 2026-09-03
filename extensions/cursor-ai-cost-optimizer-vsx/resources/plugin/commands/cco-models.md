---
name: cco-models
description: Map CCO tiers (fast/balanced/deep) to real models your account can run; adaptive, fixed, or manual.
---

# /cco-models — choose how tier models are picked

Run the `cco-model-config` skill. It executes model discovery and asks one question:

1. **Adaptive (recommended)** — CCO ranks the models your account can actually run by capability class and price, probes them, and re-checks daily. Mapping follows availability and usage limits automatically.
2. **Fixed** — freeze today's discovered mapping in `.cursor/cco.json` (`modelOverrides`) so it never changes until you edit it.
3. **Manual** — type a model ID for each tier (must appear in `cursor-agent models`). Example: `fast=composer-2.5`, `balanced=claude-sonnet-5-thinking-high`, `deep=claude-opus-5-thinking-high`.

The result is written to `.cursor/cco/runtime.json` and into `<workspace>/.cursor/agents/cco-{fast,balanced,deep,verifier}.md` (the `model:` line is what makes each tier run on its model).

Equivalent command line:

```bash
node <plugin>/scripts/cco-discover-models.mjs --workspace .          # probe + write
node <plugin>/scripts/cco-discover-models.mjs --workspace . --no-probe
```
