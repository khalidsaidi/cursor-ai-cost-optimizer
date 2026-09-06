// Did Cursor actually load our hooks in this window? Cursor writes its own hooks log per window
// (<userData>/logs/<session>/window<N>/output_<ts>/cursor.hooks.workspaceId-<id>.log). A team policy or a
// setting that disables hooks leaves the status bar claiming "on" while nothing routes; reading that log is the
// only ground truth. Pure parsing here, tested without the editor.
import * as fs from "node:fs";
import * as path from "node:path";

export type HooksLoaded = { known: false } | { known: true; loaded: boolean; userHooks: number; projectHooks: number; reason: string | null };

/** Parse the tail of a Cursor hooks log: the newest "Loaded N ... hook(s)" lines after the last reload win. */
export function parseHooksLog(text: string): HooksLoaded {
  const lines = text.split(/\r?\n/);
  let userHooks = -1;
  let projectHooks = -1;
  let reason: string | null = null;
  let sawAnything = false;
  for (const line of lines) {
    if (/Reloading hooks configuration/.test(line)) {
      userHooks = -1;
      projectHooks = -1;
      reason = null;
    }
    const user = line.match(/Loaded (\d+) user hook/);
    if (user) {
      userHooks = Number(user[1]);
      sawAnything = true;
    }
    const project = line.match(/Loaded (\d+) project hook/);
    if (project) {
      projectHooks = Number(project[1]);
      sawAnything = true;
    }
    // Cursor's own "Claude Code hooks disabled (thirdPartyExtensibilityEnabled off)" line is about another feature.
    if (/hooks? (are |is )?disabled/i.test(line) && !/Claude Code hooks/.test(line)) {
      reason = line.replace(/^\[[^\]]*\]\s*/, "").trim();
      sawAnything = true;
    }
    if (/hook.*(policy|not allowed|blocked by)/i.test(line)) {
      reason = line.replace(/^\[[^\]]*\]\s*/, "").trim();
      sawAnything = true;
    }
  }
  if (!sawAnything) {
    return { known: false };
  }
  const loaded = !reason && (Math.max(userHooks, 0) + Math.max(projectHooks, 0)) > 0;
  return { known: true, loaded, userHooks: Math.max(userHooks, 0), projectHooks: Math.max(projectHooks, 0), reason };
}

/** The current window's newest Cursor hooks log for a real workspace (never the empty-window one). */
export function findWindowHooksLog(extensionLogDir: string): string | null {
  // <windowDir>/exthost/<extension id>  →  <windowDir>
  const windowDir = path.dirname(path.dirname(extensionLogDir));
  let best: { file: string; mtime: number } | null = null;
  try {
    for (const entry of fs.readdirSync(windowDir)) {
      if (!entry.startsWith("output_")) {
        continue;
      }
      const dir = path.join(windowDir, entry);
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith("cursor.hooks.workspaceId-") || name.includes("empty-window")) {
          continue;
        }
        const file = path.join(dir, name);
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) {
          best = { file, mtime };
        }
      }
    }
  } catch {
    return null;
  }
  return best?.file ?? null;
}

export function hooksLoadedInWindow(extensionLogDir: string): HooksLoaded {
  const file = findWindowHooksLog(extensionLogDir);
  if (!file) {
    return { known: false };
  }
  try {
    const text = fs.readFileSync(file, "utf8");
    // Only the tail matters and the file grows with every hook call.
    return parseHooksLog(text.length > 200_000 ? text.slice(-200_000) : text);
  } catch {
    return { known: false };
  }
}
