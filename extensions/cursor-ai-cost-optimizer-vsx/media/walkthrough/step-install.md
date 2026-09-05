# It is already on

Nothing to set up. After install, the status bar shows `⚡ AI Cost`; after your first routed task it shows what you saved. Everything else is in the status bar menu (click **AI Cost**): pause for this project, choose which model runs each tier, remove it.

Nothing is written into any project. The Cost Optimizer uses Cursor's own user-level config (`~/.cursor/hooks.json` entries, `~/.cursor/agents/*-tier.md`) and keeps its state in the extension's storage. **Remove** in the menu, or uninstalling the extension, takes all of it back out.

Prefer repo files for a team? `AI Cost Optimizer: Turn On / Update Models` also offers **This project only**: 8 files under the project's `.cursor/`, shareable through git.

Without a logged-in Cursor CLI the tiers are Fast → Composer 2.5, Balanced → Claude Sonnet 5, Deep → Claude Opus 5; with one, they are mapped from your account's model list. A model your plan refuses is skipped for a few hours and the task steps down a tier; one refused repeatedly is replaced.
