// Shim for Roo Code's i18n: the one message the vendored checkpoint service shows.
export function t(key: string, params?: Record<string, unknown>): string {
  if (key === "common:errors.nested_git_repos_warning") {
    return `Checkpoints are off: a nested git repository was found at ${String(params?.path ?? "")}. Move it or add it to .gitignore to restore files from the chat.`;
  }
  return key;
}
