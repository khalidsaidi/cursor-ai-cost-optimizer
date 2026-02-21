# AI Cost Optimizer (Cursor Plugin)

This plugin auto-selects an effort tier using fuzzy logic and routes work to the cheapest sufficient subagent:

- **FAST**: short answers, minimal tool use
- **BALANCED**: normal workflow
- **DEEP**: thorough + verification for risky/complex tasks

## How to use
- Default behavior: routing happens automatically via the `cco-routing` rule.
- Manual overrides: add one token anywhere in your prompt:
  - `[cco:fast]`, `[cco:balanced]`, `[cco:deep]`, `[cco:auto]`

## Setup (recommended)
Run the skill **cco-init** in a workspace to create:
- `.cursor/cco.json` (tuning)
- `.ai/cco/` (telemetry)

## Notes on model selection
Subagent model selection can be brittle across Cursor versions. This plugin sets subagents to `model: inherit` by default and optimizes “cost” by controlling *effort + tool budgets*.
