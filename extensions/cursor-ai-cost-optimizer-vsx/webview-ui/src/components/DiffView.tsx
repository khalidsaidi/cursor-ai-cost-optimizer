/**
 * A unified diff rendered like VS Code's diff editor: two line-number gutters, added and removed lines coloured
 * with the editor's own diff colours, gaps between hunks collapsed to a count. After Roo Code's DiffView.
 */
import { useMemo } from "react";
import { parseUnifiedDiff } from "../utils/parseUnifiedDiff";

export default function DiffView({ source, filePath }: { source: string; filePath?: string }) {
  const lines = useMemo(() => parseUnifiedDiff(source, filePath), [source, filePath]);
  if (!lines.length) {
    return <pre className="output">{source}</pre>;
  }
  return (
    <div className="diff" role="table">
      {lines.map((line, i) =>
        line.type === "gap" ? (
          <div key={i} className="diff-line gap" role="row">
            <span className="gutter" />
            <span className="gutter" />
            <span className="content">⋯ {line.hiddenCount} unchanged lines</span>
          </div>
        ) : (
          <div key={i} className={`diff-line ${line.type}`} role="row">
            <span className="gutter">{line.oldLineNum ?? ""}</span>
            <span className="gutter">{line.newLineNum ?? ""}</span>
            <span className="sign">{line.type === "addition" ? "+" : line.type === "deletion" ? "−" : " "}</span>
            <span className="content">{line.content || " "}</span>
          </div>
        )
      )}
    </div>
  );
}
