# Turn it on

Click **AI Cost** in the status bar and choose **Turn on**, or run **AI Cost Optimizer: Turn On / Update Models**. It takes a few seconds and no reload: the next chat in any window routes.

**For all projects** (the default). Nothing is written into any project. Cursor's own user-level config is used, the same files you could edit by hand:

- `~/.cursor/hooks.json` — the Cost Optimizer entries are merged in; entries from other tools are kept
- `~/.cursor/agents/cco-{fast,balanced,deep,verifier,explore}.md` — the tier subagents with real model ids
- the extension's own storage — model mapping, prices, per-project state

Pause it per project from the same menu. **Remove** takes all of it back out, and so does uninstalling the extension.

**This project only.** 8 files under the project's `.cursor/` (hooks, the shim, the rule, the subagents), shown to you before anything is written; commit them for teammates or ignore `.cursor/`.

Without a logged-in Cursor CLI the tiers are Fast → Composer 2.5, Balanced → Claude Sonnet 5, Deep → Claude Opus 5; with one, they are mapped and verified from your account's model list. A model your plan refuses is skipped for a few hours and the task steps down a tier.
