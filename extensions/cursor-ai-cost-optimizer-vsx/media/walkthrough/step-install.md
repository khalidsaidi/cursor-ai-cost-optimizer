# Install into this workspace

Run **AI Cost Optimizer: Install / Update in This Workspace** from the Command Palette. Before anything is written you see the list of files; everything lands under your project's `.cursor/` folder:

- `.cursor/hooks.json` — CCO hook entries are merged in; entries from other tools are kept
- `.cursor/agents/cco-{fast,balanced,deep,verifier}.md` — the four tier subagents with real model ids
- `.cursor/rules/cco-routing.mdc`, `.cursor/skills/cco-*`, `.cursor/commands/cco*.md`
- `.cursor/cco.json` (settings; `"enabled": false` opts the project out) and `.cursor/cco/` (runtime, price cache, logs)

Machines without Node.js get a self-contained hook binary at `.cursor/cco/bin/cco-hook`.
