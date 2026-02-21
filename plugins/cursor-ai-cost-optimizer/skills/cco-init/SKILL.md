---
name: cco-init
description: Initializes AI Cost Optimizer configuration and internal artifact directories for the current workspace (creates .cursor/cco.json and .ai/cco/).
metadata:
  author: Khalid Saidi
  version: 0.1.0
---

# cco-init

## What this does
1) Creates a project-level config file: `.cursor/cco.json` (if missing).
2) Creates `.ai/cco/` for routing/telemetry logs (gitignored by recommended policy).
3) Prints a short “how to use” guide (override tokens + commands).

## Agent instructions
- Locate the workspace root.
- If `.cursor/cco.json` is missing:
  - Copy defaults from `plugins/cursor-ai-cost-optimizer/config/defaults.json` (or embed them if reading file is unavailable).
- Ensure `.ai/cco/` exists.
- Ensure `.ai/README.md` exists and that `.gitignore` ignores `.ai/*` except README.
- Output the final paths and how to override routing:
  - [cco:fast], [cco:balanced], [cco:deep], [cco:auto]
