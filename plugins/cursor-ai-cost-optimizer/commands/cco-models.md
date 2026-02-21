---
name: cco-models
description: Guided setup for mapping CCO modes (fast/balanced/deep) to real Cursor models.
---

# /cco-models - Pick How Models Are Chosen

Use this command to set model behavior in one step.

## Choose one option
1) **Automatic (recommended for most users)**  
CCO keeps model choice automatic and adapts to each user/account.

2) **Lock current working models**  
CCO freezes whatever mapping is currently discovered.
Example: if discovery currently says `fast=A`, `balanced=B`, `deep=C`, CCO saves `A/B/C` and reuses them until changed.

3) **Manual (advanced)**  
You pick the model ID for each mode:
- fast
- balanced
- deep
Example custom set:
- `fast = gemini-3-flash`
- `balanced = sonnet-4.5`
- `deep = opus-4.6-thinking`

That is it. CCO saves config and refreshes the runtime mapping automatically.
