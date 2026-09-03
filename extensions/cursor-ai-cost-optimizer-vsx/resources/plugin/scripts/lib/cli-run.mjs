import { run, cursorAgentBinary, PLUGIN_ROOT } from "./common.mjs";

/** Parse stream-json output into events. */
export function parseStreamJson(stdout) {
  const events = [];
  for (const line of String(stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {}
  }
  return events;
}

export function taskCalls(events) {
  const out = [];
  for (const event of events) {
    if (event?.type !== "tool_call" || event?.subtype !== "started") {
      continue;
    }
    const task = event?.tool_call?.taskToolCall?.args;
    if (!task) {
      continue;
    }
    out.push({
      callId: event.call_id,
      subagent: task.subagentType?.custom?.name || task.subagentType?.builtin || null,
      model: task.model || null,
      description: task.description || "",
      prompt: task.prompt || ""
    });
  }
  return out;
}

export function toolNames(events) {
  const names = [];
  for (const event of events) {
    if (event?.type !== "tool_call" || event?.subtype !== "started") {
      continue;
    }
    const key = Object.keys(event.tool_call || {}).find((k) => k.endsWith("ToolCall"));
    if (key) {
      names.push(key.replace(/ToolCall$/, ""));
    }
  }
  return names;
}

/**
 * Run one headless cursor-agent request and return parsed metrics.
 * options: { workspace, model, prompt, mode ("agent"|"ask"|"plan"), plugin (bool), timeoutMs, force }
 */
export function runAgent({ workspace, model, prompt, mode = "agent", plugin = false, timeoutMs = 600_000, force = true, extraArgs = [] }) {
  const args = ["--model", model, "--trust", "-p", "--output-format", "stream-json", "--workspace", workspace];
  if (force) {
    args.push("-f");
  }
  if (mode !== "agent") {
    args.push("--mode", mode);
  }
  if (plugin) {
    args.push("--plugin-dir", process.env.CCO_PLUGIN_ROOT || PLUGIN_ROOT);
  }
  args.push(...extraArgs, prompt);
  const started = Date.now();
  const res = run(cursorAgentBinary(), args, { timeout: timeoutMs });
  const events = parseStreamJson(res.stdout);
  const result = [...events].reverse().find((e) => e?.type === "result") || null;
  const init = events.find((e) => e?.type === "system" && e?.subtype === "init") || null;
  return {
    status: res.status,
    timedOut: res.error?.code === "ETIMEDOUT",
    wallMs: Date.now() - started,
    stderr: String(res.stderr || "").trim().slice(0, 1500),
    events,
    init,
    result,
    sessionId: result?.session_id || init?.session_id || null,
    usage: result?.usage || null,
    durationApiMs: Number(result?.duration_api_ms || 0),
    isError: Boolean(result?.is_error) || res.status !== 0 || !result,
    resultText: String(result?.result || ""),
    tasks: taskCalls(events),
    tools: toolNames(events)
  };
}
