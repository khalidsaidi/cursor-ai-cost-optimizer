# Set up

Click **AI Cost** in the status bar or run **AI Cost Optimizer: Set Up / Update**, then choose where:

**Everywhere** (recommended). Nothing is written into any project. CCO registers in Cursor's own user-level config, the same files you would edit by hand:

- `~/.cursor/hooks.json` — CCO's hook entries are merged in; entries from other tools are kept
- `~/.cursor/agents/cco-{fast,balanced,deep,verifier,explore}.md` — the tier subagents with real model ids
- the extension's own storage — model mapping, prices, per-project state, and the routing rule that Cursor loads per workspace

Reload the window once after setup (the notification offers it); new windows need nothing. Pause it per project from the same menu. **Remove** takes all of it back out, and so does uninstalling the extension.

**This project only.** 8 files under the project's `.cursor/` (hooks.json, the shim, the rule, five subagents) plus a git-ignored state folder. Commit them to share the setup with teammates; they are a no-op without the extension.

Either way you see the exact list before anything is written.
