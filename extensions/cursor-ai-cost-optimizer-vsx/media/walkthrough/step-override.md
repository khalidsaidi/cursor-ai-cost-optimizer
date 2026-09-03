# Steer with override tokens

Anywhere in a prompt:

- `[cco:fast]` — cheapest tier, quick answers and small edits
- `[cco:balanced]` — typical implementation work
- `[cco:deep]` — risky or complex work
- `[cco:auto]` — back to automatic routing
- `[cco:off]` — skip CCO for this request

**AI Cost Optimizer: Recommend Tier** scores selected text with the same heuristics the hooks use and offers to insert the token.
