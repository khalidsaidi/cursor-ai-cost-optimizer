/**
 * Unified diff → renderable lines with old/new line numbers and compact gaps between hunks.
 * Adapted from Roo Code's webview-ui/src/utils/parseUnifiedDiff.ts (Apache-2.0, RooCodeInc/Roo-Code).
 */
import { parsePatch } from "diff";

export interface DiffLine {
  oldLineNum: number | null;
  newLineNum: number | null;
  type: "context" | "addition" | "deletion" | "gap";
  content: string;
  hiddenCount?: number;
}

export function parseUnifiedDiff(source: string, filePath?: string): DiffLine[] {
  if (!source) {
    return [];
  }
  try {
    const patches = parsePatch(source);
    if (!patches || patches.length === 0) {
      return [];
    }
    const patch = filePath
      ? (patches.find((p) => [p.newFileName, p.oldFileName].some((n) => typeof n === "string" && (n === filePath || n.endsWith("/" + filePath)))) ?? patches[0])
      : patches[0];
    if (!patch) {
      return [];
    }
    const lines: DiffLine[] = [];
    let prevHunk: { newStart: number; newLines: number; oldStart: number; oldLines: number } | null = null;
    for (const hunk of patch.hunks || []) {
      if (prevHunk) {
        const gapNew = hunk.newStart - (prevHunk.newStart + prevHunk.newLines);
        const gapOld = hunk.oldStart - (prevHunk.oldStart + prevHunk.oldLines);
        const hidden = Math.max(gapNew, gapOld);
        if (hidden > 0) {
          lines.push({ oldLineNum: null, newLineNum: null, type: "gap", content: "", hiddenCount: hidden });
        }
      }
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      for (const raw of hunk.lines || []) {
        const firstChar = raw[0];
        const content = raw.slice(1);
        if (firstChar === "-") {
          lines.push({ oldLineNum: oldLine, newLineNum: null, type: "deletion", content });
          oldLine += 1;
        } else if (firstChar === "+") {
          lines.push({ oldLineNum: null, newLineNum: newLine, type: "addition", content });
          newLine += 1;
        } else {
          lines.push({ oldLineNum: oldLine, newLineNum: newLine, type: "context", content });
          oldLine += 1;
          newLine += 1;
        }
      }
      prevHunk = hunk;
    }
    return lines;
  } catch {
    return [];
  }
}
