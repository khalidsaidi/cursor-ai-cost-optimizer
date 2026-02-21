---
name: cco-benchmark
description: Run the real chaos benchmark (isolated temp workspace) to compare baseline routing vs joint scoring.
---

# /cco-benchmark - Real Cost Benchmark

Proof, not promises. This command runs real benchmark calls and shows measurable impact.

## Current scorecard
From the latest real run (February 21, 2026, 24 paired runs):
- Estimated cost: `$0.194389` -> `$0.041031` (`78.89%` reduction)
- Average `duration_api_ms`: `14379.7` -> `5466.8`
- Quality pass rate: `75.00%` -> `75.00%`

Visual dashboard:
- `../assets/benchmark-dashboard.svg`
- `../assets/benchmark-scenario-map.svg`
- `../assets/benchmark-top10-savings.svg`

![Real Benchmark Dashboard](../assets/benchmark-dashboard.svg)
![Savings by Scenario Group](../assets/benchmark-scenario-map.svg)
![Top 10 Scenario Savings](../assets/benchmark-top10-savings.svg)

Run this from the repo root:

```bash
node plugins/cursor-ai-cost-optimizer/scripts/cco-joint-chaos-real.mjs --workspace . --repeats 2
```

What it does:
- Creates an isolated temporary workspace (first-time-user style).
- Runs real `cursor-agent` requests across a chaos scenario matrix.
- Compares:
  - baseline fuzzy routing
  - joint scorer routing (`TotalLoss = wc*C_hat + wq*R_hat + wl*L_hat`)
- Writes reports:
  - `.ai/cco/joint-chaos-real-report.json`
  - `.ai/cco/joint-chaos-real-report.md`

If you want to inspect the temp workspace after run:

```bash
node plugins/cursor-ai-cost-optimizer/scripts/cco-joint-chaos-real.mjs --workspace . --repeats 2 --keep-tmp
```
