#!/usr/bin/env node
/** sessionEnd hook: append a session record for the report. Fire-and-forget. */
import { readStdin, safeJsonParse, workspaceFromPayload, workspacePaths, appendJsonl, emit, nowIso, isEnabled, applyScopeArgs } from "./lib/common.mjs";
applyScopeArgs();

async function main() {
  const payload = safeJsonParse((await readStdin()).trim() || "{}");
  const workspace = workspaceFromPayload(payload);
  if (workspace && isEnabled(workspace).enabled) {
    appendJsonl(workspacePaths(workspace).hooksLogPath, {
      ts: nowIso(),
      event: "sessionEnd",
      conversation_id: payload.conversation_id ?? null,
      model: payload.model ?? null,
      reason: payload.reason ?? null,
      duration_ms: payload.duration_ms ?? null,
      cursor_version: payload.cursor_version ?? null
    });
  }
  emit({ continue: true });
}

main().catch(() => emit({ continue: true }));
