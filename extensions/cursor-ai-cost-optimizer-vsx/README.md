# AI Cost Optimizer for Cursor

Routes each Cursor request to the **cheapest sufficient model tier** — `fast`, `balanced` or `deep` — by
delegating to tier subagents that run on cheaper models, with hooks that enforce risk guardrails, learn from
outcomes and log every decision. This extension sets up the
[AI Cost Optimizer plugin](https://github.com/khalidsaidi/cursor-ai-cost-optimizer) inside your project without
the Cursor plugin marketplace, and ships a self-contained hook binary for machines without Node.js.

## Getting started

1. **Set it up in your project** — Command Palette → `AI Cost Optimizer: Set Up / Update in This Workspace`
   (or click **AI Cost** in the status bar). You see the list of files first; everything is written under
   `.cursor/` in the open folder, and the tiers are mapped to models your account can run.
2. **Start a new chat and work normally.** Keep your usual chat model. Each routed task ends with one line like
   `[cco: FAST → composer-2.5 • 0.3x of your chat model • est. $0.02]`. Nothing is blocked; risky work always
   goes to the strong tier.
3. **Steer when you want to** — `[cco:fast]`, `[cco:balanced]`, `[cco:deep]` in a prompt force a tier,
   `[cco:off]` bypasses routing for one request. `/cco-report` shows decisions and estimated savings.

## Features

- **Tiered routing with real savings**: the routing rule scores each request (complexity, risk, breadth,
  uncertainty, latency) and delegates to `cco-fast` / `cco-balanced` / `cco-deep` subagents, each pinned to a
  model your account can run. Delegation only happens when the tier model is materially cheaper.
- **Hooks that enforce it**: the Task guard rewrites mis-routed delegations and applies guardrails (high risk
  never runs FAST); the tool gate keeps expensive chat models from doing cheap work themselves; outcome learning
  escalates tiers that keep failing; every decision is logged to `.cursor/cco/state/decisions.jsonl`.
- **Zero-dependency hooks**: platform builds bundle a `cco-hook` binary, so hooks run without Node.js.
- **Status bar** `AI Cost` with each tier's model and rate multiplier, the estimated savings in this project,
  and a warning icon when the price table is older than 7 days or a tier is still `inherit` (run `/cco-init`).
- **Recommend Tier** scores selected text with the same heuristics the hooks use.

## Commands

| Command | What it does |
| --- | --- |
| AI Cost Optimizer: Set Up / Update in This Workspace | Sets up (or refreshes) `.cursor/` for the open folder after a confirmation. |
| AI Cost Optimizer: Remove from This Workspace | Removes everything the install wrote; other tools' hook entries and your own files are kept. |
| AI Cost Optimizer: Show Tier Rates / Recommend a Tier | Cost statement for this project — each tier's model and its rate relative to your chat model (`FAST → composer-2.5 • 0.1x of claude-opus-5 (Rate is counted at 0.1x.)`) — and, for selected text, the recommended tier with its override token. |
| AI Cost Optimizer: Insert [cco:fast] / [cco:balanced] / [cco:deep] | Inserts an override token at the cursor (editor commands). |
| AI Cost Optimizer: Open Status Menu | The same menu as clicking **AI Cost** in the status bar. |
| AI Cost Optimizer: Show Log | Opens the "AI Cost Optimizer" log output. |
| AI Cost Optimizer: Collect Diagnostics | Copies a bug-report summary (runtime mapping, hook mode, binary hash, Node and Cursor versions) to the clipboard. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cco.hookRuntime` | `auto` | `auto` uses the bundled binary when this build has one for your platform, else Node.js; `binary` / `node` force one. |
| `cco.nodePath` | `""` | Node.js executable used to run the plugin's setup scripts (default: `node` on PATH, then Cursor's own Node). |

Per-project settings live in `.cursor/cco.json` (`"enabled": false` opts a project out; `modelOverrides`
pins models; `shellGuard.enabled` turns on the destructive-command guard).

## Requirements

- Cursor 3.13 or newer (project hooks, subagents).
- The Cursor CLI (`cursor-agent`) logged in, for model discovery and probing.
- **Node.js >= 18 on the PATH Cursor sees.** The hook entries in `.cursor/hooks.json` run `node .cursor/cco-hook.mjs`,
  so the file stays portable for every teammate who clones the repo. On a machine without Node, the bundled
  `cco-hook` binary is used instead (`cco.hookRuntime`), which makes the hook entries point at a machine-local path.
- A trusted, local workspace (the extension writes `.cursor/` files and installs hooks that execute code).

## Platform support

One VSIX is published per target, each carrying the hook binary compiled for that platform:

| Target | Runner that builds, tests and installs it in CI |
| --- | --- |
| Linux x64 | `ubuntu-latest` |
| Linux ARM64 | `ubuntu-24.04-arm` |
| Windows x64 | `windows-latest` |
| Windows ARM64 | `windows-11-arm` |
| macOS Intel | `macos-15-intel` |
| macOS Apple Silicon | `macos-latest` |

On every target, CI compiles the binary natively, runs the unit suite (including the compiled-binary tests), pipes
real hook payloads through the binary, runs the VS Code integration suite, packages the VSIX with `--target`, then
installs that VSIX into a downloaded VS Code with `--install-extension`, lists it back with its version and
uninstalls it (`npm run verify:vsix`). A release publishes all six under the same version.

## What it does to your Cursor

Measured against the bar set by the big first-party extensions:

| | This extension |
| --- | --- |
| On install | Registers commands and a status bar item. No toast, no files, no settings changed. |
| On setup (you confirm first) | 8 files under the project's `.cursor/`: hooks.json (merged), the shim, the rule, five subagents. Plus a git-ignored state folder. They show up in git status; commit them or ignore `.cursor/`. |
| While you chat | One hook process per tool call: about 0.05 s (44 ms measured with Node, 37 ms with the binary). One footer line per routed task. Nothing blocked by default. |
| Projects you did not set up | Untouched. No files, no messages, no hooks. |
| On extension update | The pinned plugin path and binary are refreshed silently. |
| On Remove from This Workspace | Everything above is removed; other tools' hook entries and your files are kept. |
| If you uninstall the extension without removing | Project files stay; the shim retires its own hook entries after 7 days. Run Remove first to leave nothing. |

## What is written to your workspace

Only files under `<workspace>/.cursor/`; nothing elsewhere in the repo and nothing in your home directory:

- `.cursor/hooks.json` — CCO entries merged in (`"<abs path>/.cursor/cco/bin/cco-hook" <event>` or
  `node .cursor/cco-hook.mjs <event>`); entries from other tools are preserved.
- `.cursor/agents/cco-{fast,balanced,deep,verifier}.md` — tier subagents with a concrete `model:`; generated
  files carry a marker and are never overwritten if you edit them.
- `.cursor/rules/cco-routing.mdc` — the routing rule. (Skills and chat commands are not copied; the extension's own commands cover them.)
- `.cursor/cco.json` — project settings (optional; created when you change a setting). `.cursor/cco-hook.mjs` — hook shim, committed next to hooks.json. `.cursor/cco/` — `plugin-path.txt`, `runtime.json`,
  `pricing.json`, `bin/cco-hook` (binary mode), `extension-manifest.json`, and `state/` (logs, sessions).
  Add `.cursor/cco/` to `.gitignore` if you do not want logs in git — the extension never edits `.gitignore`.

See **Uninstall** below before removing the extension.

## Network access and data

The extension itself has no telemetry and opens no connections. Two network activities happen during
**Set Up / Update** and later hook runs, both performed by the bundled plugin scripts:

1. **Pricing**: `https://cursor.com/docs/models-and-pricing.md` is fetched (setup, and again by the
   `workspaceOpen`/`sessionStart` hooks when the cache is older than `pricing.refreshHours`, default 24 h). A
   bundled snapshot is used when the fetch fails.
2. **Model discovery**: `cursor-agent models` and `cursor-agent --version` are run (setup, and by the hooks when
   the mapping is older than `discovery.refreshHours`). Running `/cco-init` additionally sends short **probe
   requests** through the Cursor CLI to confirm each candidate model actually runs on your account — those
   count against your Cursor usage like any other request.

What is stored locally, all under `<workspace>/.cursor/cco/`: `runtime.json` (available model ids and the
tier mapping), `pricing.json` (the price table), and `state/` with `decisions.jsonl` (per delegation: tier,
requested/final subagent, model id, effort scores, guardrail, cost estimates), `hooks.jsonl` (hook event names,
tool names, allow/deny reasons), `sessions/` (conversation ids, chat model id, counters) and `last-prompt.json`
(scores only). **Prompt text is never stored.** Delete `.cursor/cco/state/` at any time, or run **Uninstall from
This Workspace** to remove everything; add `.cursor/cco/` to `.gitignore` to keep logs out of git.

## Uninstall

1. Run **AI Cost Optimizer: Remove from This Workspace** in every project where you installed it. It removes
   the CCO entries from `.cursor/hooks.json` (other entries stay), `.cursor/agents/cco-{fast,balanced,deep,verifier}.md`
   (only files carrying the generated marker), `.cursor/cco.json`, `.cursor/cco/` (shim, binary, runtime,
   pricing, state) and `.cursor/rules/cco-routing.mdc`.
2. Then uninstall the extension. Removing the extension **alone** leaves those files in place: the hook entries
   keep pointing at `.cursor/cco/bin/cco-hook` (still present, so hooks keep working) or, in node mode, at the
   shim whose `plugin-path.txt` points at the deleted extension folder — Cursor then reports failing hooks and the
   doctor cannot run because the extension is gone. The `vscode:uninstall` hook only removes the extension's own
   global storage. Without the extension you can still clean a project with the plugin:
   `node <plugin>/scripts/cco-init.mjs --workspace . --uninstall` (`<plugin>` from `.cursor/cco/plugin-path.txt`).

## License

MIT — see LICENSE. Contributing, building and the proof harness are documented in CONTRIBUTING.md.
