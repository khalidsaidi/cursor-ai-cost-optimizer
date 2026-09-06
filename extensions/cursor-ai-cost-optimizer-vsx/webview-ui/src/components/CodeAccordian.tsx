/**
 * A collapsible block under a tool row, after Cline's CodeAccordian: a header with the file path (or "output"),
 * a chevron, and a body that is either a diff or plain text.
 */
import DiffView from "./DiffView";
import { vscode } from "../types";

interface Props {
  path: string | null;
  diff: string | null;
  output: string | null;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

export default function CodeAccordian({ path, diff, output, isExpanded, onToggleExpand }: Props) {
  const stats = diff ? diffStats(diff) : null;
  return (
    <div className="accordian">
      <button
        type="button"
        className="accordian-header"
        aria-expanded={isExpanded}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpand();
          }
        }}
      >
        <span className="chevron">{isExpanded ? "▾" : "▸"}</span>
        <span className="accordian-title">{path ?? (diff ? "diff" : "output")}</span>
        {stats ? (
          <span className="diff-stats">
            <span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span>
          </span>
        ) : null}
        {path ? (
          <a
            href="#"
            className="open-file"
            title="Open file"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              vscode.postMessage({ type: "open", path });
            }}
          >
            open
          </a>
        ) : null}
      </button>
      {isExpanded ? <div className="accordian-body">{diff ? <DiffView source={diff} filePath={path ?? undefined} /> : <pre className="output">{output}</pre>}</div> : null}
    </div>
  );
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}
