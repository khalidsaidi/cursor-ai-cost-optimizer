/**
 * Self-check: run the very hook command Cursor will run, with a synthetic preToolUse payload, and time it.
 * If it fails or is slow, the extension turns its hooks off rather than let every tool call in Cursor stall.
 * (Copilot pattern: degrade to "off" with one clear message, never to "the editor is broken".)
 */
import { spawn } from "child_process";

export interface SelfCheckResult {
  ok: boolean;
  ms: number;
  output: string;
  error: string | null;
}

export function runHookCommand(command: string, cwd: string, payload: object, timeoutMs = 6000): Promise<SelfCheckResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = "";
    let err = "";
    let done = false;
    // hooks.json commands are shell strings (Cursor runs them through the platform shell)
    const child = spawn(command, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        resolve({ ok: false, ms: Date.now() - started, output: out, error: `no answer within ${timeoutMs} ms` });
      }
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, ms: Date.now() - started, output: out, error: e.message });
      }
    });
    child.on("close", (code) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      let ok = code === 0;
      if (ok) {
        try {
          const parsed = JSON.parse(line);
          ok = typeof parsed === "object" && parsed !== null;
        } catch {
          ok = false;
        }
      }
      resolve({ ok, ms: Date.now() - started, output: out.slice(-500), error: ok ? null : (err || `exit ${code}, output: ${line.slice(0, 200)}`).slice(0, 500) });
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}
