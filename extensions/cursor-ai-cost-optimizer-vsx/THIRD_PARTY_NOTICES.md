# Third-party notices

The cost-routed chat panel (`webview-ui/`) follows the structure of two open-source VS Code agents, both under the Apache License 2.0:

- **Cline** (https://github.com/cline/cline): the shape of the chat view (a virtualised message list over an autosizing input), the task header with tokens and cost, the per-tool accordion rows, and Markdown replies rendered with react-markdown, remark-gfm and rehype-highlight.
- **Roo Code** (https://github.com/RooCodeInc/Roo-Code): `webview-ui/src/utils/parseUnifiedDiff.ts` is adapted from `webview-ui/src/utils/parseUnifiedDiff.ts`, and the diff view's two-gutter layout follows `webview-ui/src/components/common/DiffView.tsx`.

Copyright of the adapted code remains with its authors. The Apache License 2.0 text is at https://www.apache.org/licenses/LICENSE-2.0.

Bundled libraries in the panel: react, react-dom (MIT), react-markdown, remark-gfm, rehype-highlight (MIT), react-virtuoso (MIT), react-textarea-autosize (MIT), diff (BSD-3-Clause), highlight.js (BSD-3-Clause).
