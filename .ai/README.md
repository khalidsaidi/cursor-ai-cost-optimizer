# .ai — Agent Artifacts (Internal)

This directory is reserved for *agent-generated* artifacts that should **not** pollute the actual plugin code:

Examples:
- routing decision logs
- experiment notes
- temporary analysis outputs
- scratch files, drafts, transcripts

Policy:
- Everything in `.ai/` is gitignored **except** this README.
- If you need a versioned design doc, put it in `docs/` instead.
