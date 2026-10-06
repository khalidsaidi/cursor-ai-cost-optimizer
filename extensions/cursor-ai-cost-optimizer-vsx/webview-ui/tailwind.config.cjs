/** Tailwind is here only for the vendored Cline and Roo Code components, which use its utilities; theme tokens map their names to VS Code's colours. */
module.exports = {
  content: { relative: true, files: ["./src/**/*.{ts,tsx}"] },
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        code: "var(--vscode-editor-background)",
        description: "var(--vscode-descriptionForeground)",
        foreground: "var(--vscode-foreground)",
        "editor-group-border": "var(--vscode-editorGroup-border)"
      },
      borderRadius: { xs: "2px" }
    }
  }
};
