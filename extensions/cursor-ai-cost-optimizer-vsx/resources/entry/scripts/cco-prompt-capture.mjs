#!/usr/bin/env node
/**
 * beforeSubmitPrompt hook (IDE): capture the raw user prompt so the Task guard can honor
 * override tokens even when the parent drops them from the delegated prompt, and pre-score
 * the request for the report. Never blocks; always {continue:true}.
 */
import { readStdin, safeJsonParse, workspaceFromPayload, workspacePaths, writeJson, appendJsonl, emit, nowIso, isEnabled, applyScopeArgs } from "./lib/common.mjs";
applyScopeArgs();
import { loadConfig } from "./lib/config.mjs";
import { parseOverride, heuristicScores, decideTier, isQuestionLike, isTinyTask } from "./lib/scorer.mjs";
import { updateSession, loadSession, createSession, normalizeModelId } from "./lib/session.mjs";
import { readJsonSafe } from "./lib/common.mjs";
import { refreshDiscoveryIfStale } from "./cco-session-start.mjs";

async function main() {
  const payload = safeJsonParse((await readStdin()).trim() || "{}");
  const workspace = workspaceFromPayload(payload);
  if (!workspace || !isEnabled(workspace).enabled) {
    emit({ continue: true });
    return;
  }
  try {
    const paths = workspacePaths(workspace);
    const config = loadConfig(workspace);
    if (!readJsonSafe(paths.runtimePath)) {
      // First chat in this workspace and no workspaceOpen ran: map tiers now (no probes, ~1-2 s).
      const discovery = refreshDiscoveryIfStale({ workspace, paths, config });
      appendJsonl(paths.hooksLogPath, { ts: nowIso(), event: "beforeSubmitPrompt:discovery", discovery });
    }
    const prompt = String(payload.prompt || "");
    const override = parseOverride(prompt, config?.overrideTokens || {});
    const scores = heuristicScores(prompt);
    const decision = decideTier({ scores, override, config });
    // Privacy: no prompt text is persisted; only scores, the override token, and the decision.
    const record = {
      ts: nowIso(),
      conversation_id: payload.conversation_id ?? null,
      generation_id: payload.generation_id ?? null,
      model: payload.model ?? null,
      promptChars: prompt.length,
      override,
      heuristic: { scores, tier: decision.tier, effort: decision.effort, guardrail: decision.guardrail, questionLike: isQuestionLike(prompt) }
    };
    writeJson(paths.lastPromptPath, record);
    // In the IDE, sessionStart is not delivered per chat; the first user prompt is where the parent
    // conversation becomes known. Create the session here if sessionStart did not.
    if (payload.conversation_id && !loadSession(workspace, payload.conversation_id)) {
      createSession({ workspace, conversationId: payload.conversation_id, model: normalizeModelId(payload.model), payload });
    }
    // Each user turn is a new task: reset per-turn gate state so routing applies again.
    updateSession(workspace, payload.conversation_id, (s) => ({
      userPrompt: null,
      promptMeta: { override, questionLike: isQuestionLike(prompt), tiny: isTinyTask(prompt), chars: prompt.length },
      decision: { tier: decision.tier, effort: decision.effort, guardrail: decision.guardrail, scores },
      override,
      turn: (s.turn || 0) + 1,
      delegations: [],
      denials: 0,
      footerSent: false,
      readCount: 0,
      readNudged: false,
      previousTurns: [...(s.previousTurns || []).slice(-9), { delegations: (s.delegations || []).length, denials: s.denials || 0, directWork: s.directWork || 0 }]
    }));
    appendJsonl(paths.hooksLogPath, { ...record, event: "beforeSubmitPrompt" });
  } catch {}
  emit({ continue: true });
}

main().catch(() => emit({ continue: true }));
