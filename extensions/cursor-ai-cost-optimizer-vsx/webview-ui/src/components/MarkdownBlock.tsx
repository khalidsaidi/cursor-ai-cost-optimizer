/**
 * Replies as Markdown, the way Cline's MarkdownBlock does it: react-markdown with GitHub-flavoured Markdown and
 * highlighted code blocks. Unified diffs inside ```diff fences render with the diff view instead.
 */
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import DiffView from "./DiffView";

function extractText(children: unknown): string {
  if (typeof children === "string") {
    return children;
  }
  if (Array.isArray(children)) {
    return children.map(extractText).join("");
  }
  if (children && typeof children === "object" && "props" in (children as Record<string, unknown>)) {
    return extractText((children as { props: { children?: unknown } }).props.children);
  }
  return "";
}

const MarkdownBlock = memo(function MarkdownBlock({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      components={{
        pre({ children }) {
          const child = Array.isArray(children) ? children[0] : children;
          const className = String((child as { props?: { className?: string } })?.props?.className ?? "");
          if (/language-diff/.test(className)) {
            return <DiffView source={extractText((child as { props: { children?: unknown } }).props.children)} />;
          }
          return <pre className="code-block">{children}</pre>;
        },
        a({ href, children }) {
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
});

export default MarkdownBlock;
