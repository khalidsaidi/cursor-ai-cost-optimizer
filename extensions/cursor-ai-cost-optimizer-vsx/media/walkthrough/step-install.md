# Set up in this workspace

Run **AI Cost Optimizer: Set Up / Update in This Workspace** from the Command Palette, or click **AI Cost** in the status bar. Before anything is written you see the list of files; everything lands under your project's `.cursor/` folder:

- `.cursor/hooks.json` and `.cursor/cco-hook.mjs` — CCO's hook entries (merged in; entries from other tools are kept) and the small shim they run. Commit both; they are a no-op for teammates without the extension.
- `.cursor/agents/cco-{fast,balanced,deep,verifier,explore}.md` — the tier subagents with real model ids
- `.cursor/rules/cco-routing.mdc`, `.cursor/skills/cco-*`, `.cursor/commands/cco*.md` — the routing rule and chat commands
- `.cursor/cco/` — model mapping, price cache and logs (ignores itself in git)

Nothing is written outside the project, nothing happens in projects you did not set up, and **Remove from This Workspace** takes it all back out.
