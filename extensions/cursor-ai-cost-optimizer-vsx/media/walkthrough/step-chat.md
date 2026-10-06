# The cost-routed chat

Cursor's own chat shows "Auto" whatever model actually ran, and no extension can change that. This view is a chat the extension owns, so the model is on every reply.

| What you see | What it means |
|---|---|
| **Composer 2.5 · Fast · $0.03 · at Auto's rate $0.08** | The model and tier that produced the reply, what the turn cost from the token usage the Cursor CLI reports, and what the same tokens cost at Auto's billed rate. |
| ✓ Edit units.mjs · **open** | Every file the model read, searched, edited or ran. Edits open as a diff; commands show their output. |
| **Restore files to before this turn** | A checkpoint of the workspace is taken before each turn (Roo Code's shadow-git checkpoints); one click puts the files back. |
| The chip above the input | The active file and selection go with the request, Copilot-style. Untick it to leave them out. |
| **History** | Earlier conversations in this workspace. A reload keeps the current one. |

Routing: routine work goes to the Fast tier's model, medium work to Balanced, risky or complex work to Deep; the picker under the input forces a tier. A model at its usage limit on your plan is swapped for the next tier, with one line saying so.

Needs the Cursor CLI (`cursor-agent`) installed and logged in, and `git` for checkpoints. The view says so, with buttons, until both are in place.
