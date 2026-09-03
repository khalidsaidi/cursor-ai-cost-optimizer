# Contributing

Thanks for considering contributing!

## Development
- Keep plugin components in `plugins/cursor-ai-cost-optimizer/`.
- Run validation and unit tests before pushing:
  - `node scripts/validate-template.mjs`
  - `node --test plugins/cursor-ai-cost-optimizer/test/`
- Real Cursor checks (cost usage, need `cursor-agent` logged in):
  - `node plugins/cursor-ai-cost-optimizer/scripts/cco-e2e-real.mjs --workspace .`
  - `node plugins/cursor-ai-cost-optimizer/scripts/cco-benchmark.mjs --workspace .`
- Refresh the bundled price snapshot when Cursor changes pricing:
  - `node plugins/cursor-ai-cost-optimizer/scripts/cco-refresh-pricing.mjs --bundle`

## Style
- Keep rules/skills/agents concise and practical.
- Avoid breaking changes without bumping versions and updating CHANGELOG.
