// Shim for Roo Code's src/utils/path.ts: only what the vendored checkpoint service uses.
import * as path from "path";

function normalize(p: string): string {
  let n = path.normalize(p);
  if (n.length > 1 && (n.endsWith("/") || n.endsWith("\\"))) {
    n = n.slice(0, -1);
  }
  return process.platform === "win32" ? n.toLowerCase() : n;
}

export function arePathsEqual(a?: string, b?: string): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return normalize(a) === normalize(b);
}
