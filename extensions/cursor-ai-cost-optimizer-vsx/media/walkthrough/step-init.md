# Start a new chat and work normally

Keep whatever chat model you like. AI Cost Optimizer routes each task to the cheapest tier that can do it well and runs it on that tier's model:

| Tier | Typical work | Default model |
|---|---|---|
| FAST | quick answers, small edits, lookups | Composer 2.5 |
| BALANCED | normal features and bug fixes | Claude Sonnet 5 (thinking) |
| DEEP | risky, complex, multi-file, security, data | Claude Opus 5 (thinking) |

Each routed task ends with one line, for example:

```
Cost Optimizer · Fast on Composer 2.5 · ~$0.02, saves ~$0.05
```

Nothing is blocked. Cost routing is advice to the chat model; only your explicit `[cco:<tier>]` tokens and risky work (which always goes to the strong tier) are enforced.

The status bar item **AI Cost** shows the tier mapping, rates relative to your chat model, and the estimated savings for this project. Run `/cco-report` in a chat for the full report, `/cco-models` to change models, `/cco-off` to pause routing in this project.
