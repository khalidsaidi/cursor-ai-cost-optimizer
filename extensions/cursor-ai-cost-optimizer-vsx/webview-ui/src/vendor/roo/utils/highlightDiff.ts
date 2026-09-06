// Shim for Roo Code's utils/highlightDiff.ts with the same signature: highlight the old and new side of a hunk
// and return one React node per line. Roo uses shiki; this uses lowlight (highlight.js), which the panel already
// bundles for Markdown code blocks, and the theme is Cline's codeblock-parser.css mapped to VS Code's colours.
import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

function highlightLines(text: string, lang: string): ReactNode[] {
  const lines = text.split("\n");
  if (!text.trim()) {
    return lines.map((line) => line || "");
  }
  try {
    const language = lowlight.registered(lang) ? lang : "plaintext";
    // Each line is highlighted on its own so line boundaries stay exact (the same fallback Roo uses).
    return lines.map((line) => {
      if (!line.trim()) {
        return line;
      }
      const tree = lowlight.highlight(language, line);
      return toJsxRuntime({ type: "element", tagName: "span", properties: {}, children: tree.children } as never, { Fragment, jsx, jsxs });
    });
  } catch {
    return lines.map((line) => line || "");
  }
}

export async function highlightHunks(oldText: string, newText: string, lang: string, _theme: "light" | "dark", _hunkIndex = 0, _filePath?: string): Promise<{ oldLines: ReactNode[]; newLines: ReactNode[] }> {
  return { oldLines: highlightLines(oldText, lang), newLines: highlightLines(newText, lang) };
}
