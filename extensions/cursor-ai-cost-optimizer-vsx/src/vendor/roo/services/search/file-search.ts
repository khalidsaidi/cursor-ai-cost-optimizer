// Shim for Roo Code's ripgrep-backed file search: the checkpoint service only uses it to find nested
// `.git/HEAD` files. A bounded directory walk does that without ripgrep.
import fs from "fs/promises";
import * as path from "path";

const SKIP = new Set(["node_modules", ".git", "dist", "out", "build", "target", ".venv", "venv", "__pycache__", ".next", ".cache"]);

export async function executeRipgrep({ workspacePath }: { args: string[]; workspacePath: string }): Promise<Array<{ type: "file" | "folder"; path: string; label?: string }>> {
  const found: Array<{ type: "file" | "folder"; path: string }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || found.length > 0) {
      return;
    }
    let entries: import("fs").Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) {
        continue;
      }
      const abs = path.join(dir, e.name);
      if (e.name === ".git" && dir !== workspacePath) {
        try {
          await fs.access(path.join(abs, "HEAD"));
          found.push({ type: "file", path: path.relative(workspacePath, path.join(abs, "HEAD")) });
        } catch {
          // not a repository
        }
        continue;
      }
      if (SKIP.has(e.name)) {
        continue;
      }
      await walk(abs, depth + 1);
    }
  };
  await walk(workspacePath, 0);
  return found;
}
