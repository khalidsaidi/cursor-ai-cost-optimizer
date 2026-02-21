# AI Cost Optimizer (Cursor Plugin)

This plugin auto-selects an effort tier using fuzzy logic and routes work to the cheapest sufficient subagent:

- **FAST**: short answers, minimal tool use
- **BALANCED**: normal workflow
- **DEEP**: thorough + verification for risky/complex tasks

## How to use
- Default behavior: routing happens automatically via the `cco-routing` rule.
- Manual overrides: add one token anywhere in your prompt:
  - `[cco:fast]`, `[cco:balanced]`, `[cco:deep]`, `[cco:auto]`

## Components
- Rule: `rules/cco-routing.mdc`
- Skills: `skills/cco-init/SKILL.md`, `skills/cco-model-config/SKILL.md`, `skills/cco-report/SKILL.md`
- Agents: `agents/cco-router.md`, `agents/cco-fast.md`, `agents/cco-balanced.md`, `agents/cco-deep.md`, `agents/cco-verifier.md`
- Commands: `commands/cco.md`, `commands/cco-models.md`
- Hooks: `hooks/hooks.json`

## Setup (recommended)
Run the skill **cco-init** in a workspace to create:
- `.cursor/cco.json` (tuning)
- `.cursor/cco-runtime.json` (real Cursor model mapping discovered at runtime)
- `.ai/cco/` (telemetry)

## Friendly model setup
Use `/cco-models` in Cursor:
1) Automatic (recommended for most users)
2) Locked (fixed until changed)
3) Manual (advanced)

It updates `.cursor/cco.json`, reruns discovery, and shows final mapping.

What these mean:
- Automatic: best default for marketplace users; no manual model picking.
- Locked: keep the current working model choices fixed until changed.
- Manual: pick exact model IDs per mode (`fast`, `balanced`, `deep`).

Advanced users can edit `.cursor/cco.json` directly:
```json
{
  "modelOverrides": {
    "fast": "",
    "balanced": "",
    "deep": ""
  },
  "modelOverridePolicy": "best_effort"
}
```

## Real behavior test
Run the real Cursor E2E test (discovery + router checks):
```bash
node plugins/cursor-ai-cost-optimizer/scripts/cco-e2e-real.mjs --workspace .
```
This writes:
- `.ai/cco/e2e-real-report.md`
- `.ai/cco/e2e-real-report.json`

## Notes on model selection
FAST/BALANCED/DEEP are CCO routing labels, not native Cursor model tiers.
`cco-init` runs `scripts/cco-discover-models.mjs` to detect models available to the current user/session and map each tier to a real model ID in `.cursor/cco-runtime.json`.
If a preferred model is unavailable, routing falls back to `auto` while preserving effort budgets.
When account limits reduce runnable options, `.cursor/cco-runtime.json` marks `health.degraded: true` and tiers may share the same runnable model.
