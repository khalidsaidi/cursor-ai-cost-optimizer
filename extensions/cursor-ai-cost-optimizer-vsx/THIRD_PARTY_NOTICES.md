# Third-party notices

The cost-routed chat panel (`webview-ui/`) follows the structure of two open-source VS Code agents, both under the Apache License 2.0:

- **Cline** (https://github.com/cline/cline), vendored under `webview-ui/src/vendor/cline/` with its LICENSE: `components/common/CodeAccordian.tsx` (one change: diffs render with Roo Code's DiffView), `components/common/CodeBlock.tsx`, `components/common/codeblock-parser.css`, `lib/utils.ts`, `utils/getLanguageFromPath.ts`; the `components/ui/button.tsx` there is a shim of ours. The chat view's shape (a virtualised message list over an autosizing input, a task header with tokens and cost) follows Cline's ChatView and TaskHeader.
- **Roo Code** (https://github.com/RooCodeInc/Roo-Code), vendored with its LICENSE: in the webview, `webview-ui/src/vendor/roo/components/common/DiffView.tsx`, `utils/parseUnifiedDiff.ts` and `utils/getLanguageFromPath.ts` unmodified, with `utils/highlighter.ts` and `utils/highlightDiff.ts` re-implemented over lowlight (highlight.js) instead of shiki; in the extension, `src/vendor/roo/services/checkpoints/` (ShadowCheckpointService, RepoPerTaskCheckpointService, excludes, types) unmodified, with small shims for its `utils/fs`, `utils/path`, `i18n` and ripgrep-based nested-repository search.

Copyright of the adapted code remains with its authors. The Apache License 2.0 text is at https://www.apache.org/licenses/LICENSE-2.0.

Bundled libraries: in the panel, react, react-dom (MIT), react-markdown, remark-gfm, rehype-highlight, lowlight, hast-util-to-jsx-runtime (MIT), react-remark (MIT), styled-components (MIT), react-virtuoso (MIT), react-textarea-autosize (MIT), lucide-react (ISC), clsx, tailwind-merge (MIT), diff (BSD-3-Clause), highlight.js (BSD-3-Clause), Tailwind CSS utilities (MIT); in the extension, simple-git (MIT) and p-wait-for (MIT).
