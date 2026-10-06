// Shim for Roo Code's utils/highlighter.ts. Roo highlights with shiki; this panel already ships highlight.js
// (through rehype-highlight), so the same interface is served by lowlight. Only what DiffView uses is here.
const languageAliases: Record<string, string> = {
  text: "plaintext", plaintext: "plaintext", plain: "plaintext", txt: "plaintext",
  sh: "bash", zsh: "bash", shell: "bash", shellscript: "bash", console: "bash", terminal: "bash",
  js: "javascript", node: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", python3: "python", rb: "ruby", yml: "yaml", md: "markdown", cs: "csharp", kt: "kotlin",
  rs: "rust", golang: "go", "c++": "cpp", objectivec: "objectivec", ps1: "powershell", svg: "xml", csv: "plaintext"
};

export function normalizeLanguage(lang: string | undefined): string {
  const l = (lang || "plaintext").toLowerCase();
  return languageAliases[l] ?? l;
}
