---
name: cco-benchmark
description: Run the real usage-priced benchmark (baseline model vs CCO-routed tier models) in isolated temp workspaces. Costs real usage.
---

# /cco-benchmark — measure it, don't guess

This runs real `cursor-agent` requests and costs real usage. Ask the user to confirm before running it.

Runs each scenario twice in fresh temporary workspaces with real `cursor-agent` calls:
- **baseline**: one model for everything (default: your DEEP-tier model, i.e. "always use the strongest model")
- **cco**: the tier model CCO would pick for that task, with the tier's budget instruction

Cost is computed from the token usage the CLI reports (input, output, cache read, cache write) times Cursor's published per-model rates. Quality is checked deterministically: files exist, `node --test` passes, required phrases present.

```bash
node <plugin>/scripts/cco-benchmark.mjs --workspace . --repeats 1
node <plugin>/scripts/cco-benchmark.mjs --workspace . --baseline-model claude-sonnet-5-thinking-high
node <plugin>/scripts/cco-benchmark.mjs --workspace . --include-overhead   # also measures the routing overhead of the chat model delegating
```

Reports: `.ai/cco/benchmark-report.md` and `.ai/cco/benchmark-report.json`.

Notes
- Auto is not used as a baseline: on non-Enterprise plans Auto bills at whatever model it routed to, which the CLI does not expose.
- Subagent token usage is billed but not visible in the parent's CLI output, so the `--include-overhead` policy reports the parent's tokens only.
