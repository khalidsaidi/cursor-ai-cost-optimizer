# Work as usual

Keep whatever chat model you like. Each task goes to the cheapest tier that can do it well, and that tier runs on its own model. On **Auto, Composer, Grok, Sonnet and GPT** routine work stays in the chat, because on Cursor's bill a delegation costs about what the work does (measured on Auto: 6.4¢ in the chat, 7.5¢ delegated); risky or complex work goes to the Deep tier for quality, and from Opus-class chat models routine work is delegated too:

| Tier | Typical work | Model (without a CLI login) |
|---|---|---|
| Fast | quick answers, small edits, lookups | Composer 2.5 |
| Balanced | normal features and bug fixes | Claude Sonnet 5 |
| Deep | risky, complex, multi-file, security, data | Claude Opus 5 |

What you see in a chat: a subagent card named after the model and its tier (**Composer 2.5 Fast**, for example) that completes, then the answer. Click the card to see the subagent's steps and diffs; the changes land in Cursor's usual **Review** bar. The chat never adds cost lines of its own; the status bar shows what you saved in this project, and its tooltip shows the last task.

Nothing is blocked: cost routing is advice to the chat model. Your explicit `[cco:…]` requests and risky work (always the strong tier) are enforced. A model your plan refuses is skipped for a few hours and the task steps down a tier.
