---
name: cco-init
description: Initializes AI Cost Optimizer configuration and internal artifact directories for the current workspace (creates .cursor/cco.json, .cursor/cco-runtime.json, .cursor/cco-pricing.json, .cursor/cco-joint-state.json, and .ai/cco/).
metadata:
  author: Khalid Saidi
  version: 0.1.0
---

# cco-init

## What this does
1) Creates a project-level config file: `.cursor/cco.json` (if missing).
2) Discovers real runnable Cursor models for this user/session and writes `.cursor/cco-runtime.json`.
3) Refreshes pricing cache from official Cursor docs and writes `.cursor/cco-pricing.json` (best effort).
4) Initializes `.cursor/cco-joint-state.json` for EMA-based joint scoring metrics (if missing).
5) Creates `.ai/cco/` for routing/telemetry logs (gitignored by recommended policy).
6) Prints a short “how to use” guide (override tokens + commands).

## Agent instructions
- Locate the workspace root.
- If `.cursor/cco.json` is missing:
  - Copy defaults from `plugins/cursor-ai-cost-optimizer/config/defaults.json` (or embed them if reading file is unavailable).
- Run model discovery (best effort):
  - `node plugins/cursor-ai-cost-optimizer/scripts/cco-discover-models.mjs --workspace <workspace-root>`
  - This must produce `.cursor/cco-runtime.json` with discovered `fast`/`balanced`/`deep` model mappings.
- Support user model overrides in `.cursor/cco.json`:
  - `modelOverrides.fast`
  - `modelOverrides.balanced`
  - `modelOverrides.deep`
  - Optional `modelOverridePolicy`: `best_effort` (default) or `strict`
- Refresh pricing cache (best effort):
  - `printf '{"workspace_roots":["<workspace-root>"]}' | node plugins/cursor-ai-cost-optimizer/scripts/cco-session-start.mjs`
- Ensure `.cursor/cco-joint-state.json` exists (create with empty `observations` map if missing).
- Ensure `.ai/cco/` exists.
- Ensure `.ai/README.md` exists and that `.gitignore` ignores `.ai/*` except README.
- Output the final paths and how to override routing:
  - `.cursor/cco.json`
  - `.cursor/cco-runtime.json`
  - `.cursor/cco-pricing.json`
  - `.cursor/cco-joint-state.json`
  - `.ai/cco/`
  - [cco:fast], [cco:balanced], [cco:deep], [cco:auto]
- Mention user-friendly model mapping command:
  - `/cco-models`
