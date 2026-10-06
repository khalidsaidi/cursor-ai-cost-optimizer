// Shim for Roo Code's src/utils/fs.ts: only what the vendored checkpoint service uses.
import fs from "fs/promises";

export async function fileExistsAtPath(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
