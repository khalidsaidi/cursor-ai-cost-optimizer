#!/usr/bin/env node
/**
 * preToolUse hook (matcher: Task).
 * Deterministic routing enforcement at the moment of delegation:
 *  - reads the CCO-SCORES line the routing rule asks the parent to include (falls back to heuristics),
 *  - honors override tokens (from the Task prompt or the captured user prompt),
 *  - applies risk guardrails and field-learning escalation,
 *  - rewrites `subagent_type` when the parent picked a tier the policy forbids,
 *  - logs every decision to .cursor/cco/state/decisions.jsonl.
 * Fail-open: any error results in {permission:"allow"}.
 */
import {
  readStdin,
  safeJsonParse,
  workspaceFromPayload,
  workspacePaths,
  readJsonSafe,
  appendJsonl,
  hookLog,
  emit,
  nowIso,
  CCO_AGENT_NAMES,
  isEnabled, isMain, applyScopeArgs } from "./lib/common.mjs";
applyScopeArgs();
import { loadConfig } from "./lib/config.mjs";
import { parseOverride, parseScoresLine, heuristicScores, decideTier, applyStateEscalation, formatScoresLine } from "./lib/scorer.mjs";
import { loadJointState } from "./lib/state.mjs";
import { readWorkspaceAgentModel } from "./lib/agents.mjs";
import { tierFor } from "./lib/models.mjs";
import { detectTestCommand, estimateTaskCostUsd, formatUsd } from "./lib/project.mjs";
import { updateSession, loadSession, createSession, normalizeModelId, syncTurnFromTranscript, guessTranscriptPath, saveSession } from "./lib/session.mjs";
import { loadPricing, resolveModelPrice, blendedRatePerMillion } from "./lib/pricing.mjs";

export function evaluateTask({ toolInput, config, state = null, lastPrompt = null, conversationId = null, runtime = null, workspace = null }) {
  const requestedAgent = String(toolInput?.subagent_type || "");
  // Cursor's built-in `explore` subagent is the model's natural choice for research; take it over so the
  // research runs on the mapped FAST model and counts as the research step.
  const builtinExplore = requestedAgent === "explore" && workspace && readWorkspaceAgentModel(workspace, "cco-explore");
  if (requestedAgent === "cco-explore" || requestedAgent === "cco-verifier" || builtinExplore) {
    const targetAgent = builtinExplore ? "cco-explore" : requestedAgent;
    const model = (workspace && readWorkspaceAgentModel(workspace, targetAgent)) || runtime?.profiles?.fast?.model || "inherit";
    return { applies: true, research: true, requestedAgent, targetAgent, targetTier: "fast", requestedTier: "fast", rewritten: Boolean(builtinExplore), reason: targetAgent === "cco-explore" ? (builtinExplore ? "research_builtin_explore_rewritten" : "research") : "verification", override: null, overrideSource: null, scores: null, scoreSource: null, effort: null, guardrail: null, computedTier: "fast", learning: { escalated: false }, model, updatedPrompt: String(toolInput?.prompt || "") };
  }
  const requestedTier = tierFor(requestedAgent);
  if (!requestedTier) {
    return { applies: false, requestedAgent };
  }
  const prompt = String(toolInput?.prompt || "");
  const description = String(toolInput?.description || "");
  const tokens = config?.overrideTokens || {};

  let override = parseOverride(`${description}\n${prompt}`, tokens);
  let overrideSource = override ? "task_prompt" : null;
  if (!override && lastPrompt && (!conversationId || !lastPrompt.conversation_id || lastPrompt.conversation_id === conversationId)) {
    const fromUser = parseOverride(lastPrompt.prompt || "", tokens);
    if (fromUser) {
      override = fromUser;
      overrideSource = "user_prompt";
    }
  }

  let scores = parseScoresLine(prompt);
  let scoreSource = "cco_scores_line";
  if (!scores) {
    scores = heuristicScores(`${description}\n${prompt}`);
    scoreSource = "heuristic";
  }

  const decision = decideTier({ scores, override, config });
  let finalTier = decision.tier;
  let learning = { escalated: false, reason: null };
  if (config?.learning?.enabled !== false) {
    learning = applyStateEscalation({ tier: finalTier, state, config, override });
    finalTier = learning.tier;
  }

  // When the parent's own scores land in a tier the policy allows, respect the parent's choice
  // unless a guardrail or override says otherwise. This keeps the LLM's judgement primary and
  // the hook as a safety net rather than a second opinion.
  const policyMin = decision.minTier;
  const tierOrder = ["fast", "balanced", "deep"];
  const requestedIdx = tierOrder.indexOf(requestedTier);
  const minIdx = tierOrder.indexOf(policyMin);
  let target = requestedTier;
  let reason = "parent_choice_within_policy";
  if (override && override !== "auto") {
    target = override;
    reason = `override_${override}`;
  } else if (requestedIdx < minIdx) {
    target = policyMin;
    reason = decision.guardrail || "risk_guardrail";
  } else if (learning.escalated && tierOrder.indexOf(learning.tier) > requestedIdx) {
    target = learning.tier;
    reason = `learning:${learning.reason}`;
  }

  const rewritten = target !== requestedTier;
  const targetAgent = `cco-${target}`;
  const model =
    (workspace && readWorkspaceAgentModel(workspace, targetAgent)) ||
    runtime?.profiles?.[target]?.model ||
    "inherit";
  const scoresLine = formatScoresLine(scores);
  let updatedPrompt = prompt;
  if (!/CCO-SCORES:/i.test(prompt)) {
    updatedPrompt = `${scoresLine}\n${prompt}`;
  }
  const testCommand = workspace ? detectTestCommand(workspace) : null;
  if (testCommand && !/Acceptance:/i.test(updatedPrompt)) {
    updatedPrompt += `\n\nAcceptance: after your changes run \`${testCommand.command}\` and report the result. If it fails and the fix is outside your tier's budget, reply with CCO-ESCALATE instead of retrying.`;
  }

  return {
    applies: true,
    requestedAgent,
    requestedTier,
    targetAgent,
    targetTier: target,
    rewritten,
    reason,
    override,
    overrideSource,
    scores,
    scoreSource,
    effort: decision.effort,
    guardrail: decision.guardrail,
    computedTier: decision.tier,
    learning,
    model,
    updatedPrompt,
    testCommand: testCommand?.command || null
  };
}

async function main() {
  const payload = safeJsonParse((await readStdin()).trim() || "{}");
  const workspace = workspaceFromPayload(payload);
  const paths = workspace ? workspacePaths(workspace) : null;
  try {
    if (String(payload.tool_name || "") !== "Task" || !workspace || !isEnabled(workspace).enabled) {
      emit({ permission: "allow" });
      return;
    }
    const config = loadConfig(workspace);
    const state = paths ? loadJointState(paths.jointStatePath) : null;
    const sessionForOverride = payload.conversation_id ? loadSession(workspace, payload.conversation_id) : null;
    if (sessionForOverride && syncTurnFromTranscript(sessionForOverride, payload.transcript_path || guessTranscriptPath(workspace, payload.conversation_id))) {
      saveSession(workspace, sessionForOverride);
    }
    const lastPrompt = sessionForOverride?.promptMeta?.override ? { conversation_id: payload.conversation_id, prompt: `[cco:${sessionForOverride.promptMeta.override}]` } : null;
    const runtime = paths ? readJsonSafe(paths.runtimePath) : null;
    const result = evaluateTask({
      toolInput: payload.tool_input || {},
      config,
      state,
      lastPrompt,
      conversationId: payload.conversation_id || null,
      runtime,
      workspace
    });
    if (!result.applies) {
      emit({ permission: "allow" });
      return;
    }
    if (result.research) {
      if (workspace && payload.conversation_id) {
        if (!loadSession(workspace, payload.conversation_id)) {
          createSession({ workspace, conversationId: payload.conversation_id, model: normalizeModelId(payload.model), payload });
        }
        updateSession(workspace, payload.conversation_id, (s) => ({ research: [...(s.research || []), { ts: nowIso(), agent: result.targetAgent, model: result.model }] }));
      }
      if (paths && config?.enforcement?.logDecisions !== false) {
        appendJsonl(paths.decisionsPath, { ts: nowIso(), conversation_id: payload.conversation_id ?? null, requested: result.requestedAgent, final: result.targetAgent, model: result.model, rewritten: false, reason: result.reason, description: String(payload.tool_input?.description || "").slice(0, 200) });
      }
      const output = { permission: "allow", user_message: `CCO: ${result.targetAgent === "cco-explore" ? "research" : "verification"} → ${result.model}` };
      if (result.rewritten) {
        output.updated_input = { ...(payload.tool_input || {}), subagent_type: result.targetAgent };
        output.agent_message = `CCO: research runs on cco-explore (${result.model}) instead of the built-in explore subagent. Use its summary and continue.`;
      }
      emit(output);
      return;
    }
    // Keep the work in the chat when the target tier's model is not materially cheaper than the chat
    // model and the delegation is not a quality escalation (risk guardrail / user override).
    const session = workspace && payload.conversation_id ? loadSession(workspace, payload.conversation_id) : null;
    const sessionModel = session?.model || normalizeModelId(payload.model);
    const qualityDriven = Boolean(result.override && result.override !== "auto") || Boolean(result.guardrail && String(result.guardrail).startsWith("risk")) || result.learning?.escalated;
    if (config?.enforcement?.requireDelegation !== "always" && !qualityDriven && sessionModel && result.model !== "inherit") {
      const pricing = loadPricing(paths?.pricingPath);
      const sessionRate = blendedRatePerMillion(resolveModelPrice(sessionModel, pricing, { overrides: config?.pricing?.overrides }));
      const tierRate = blendedRatePerMillion(resolveModelPrice(result.model, pricing, { overrides: config?.pricing?.overrides }));
      const minSavings = Number(config?.enforcement?.minSavingsFactor ?? 1.3);
      // Escalating to a stronger (pricier) model is the parent's quality call and is always allowed;
      // only a sideways/downward move that is not materially cheaper is pointless.
      if (sessionRate && tierRate && tierRate <= sessionRate && sessionRate / tierRate < minSavings) {
        if (paths && config?.enforcement?.logDecisions !== false) {
          appendJsonl(paths.decisionsPath, { ts: nowIso(), conversation_id: payload.conversation_id ?? null, requested: result.requestedAgent, final: "chat", model: sessionModel, rewritten: false, reason: `tier_${result.targetTier}_not_cheaper_than_chat_model`, scores: result.scores, scoreSource: result.scoreSource, effort: result.effort });
        }
        emit({
          permission: "deny",
          agent_message: `CCO: do this ${result.targetTier.toUpperCase()}-tier task directly in this chat. Its model (${result.model}) is not cheaper than your chat model (${sessionModel}), so a subagent would only add cost. Proceed with the tools you need; no delegation.`,
          user_message: `CCO: ${result.targetTier.toUpperCase()} tier stays in this chat (${sessionModel} is already the right price).`
        });
        return;
      }
    }
    let payoff = "";
    let estimate = "";
    let estimateUsd = null;
    let chatEstimateUsd = null;
    let multiplier = null;
    try {
      const pricingNow = loadPricing(paths?.pricingPath);
      const est = estimateTaskCostUsd({ tier: result.targetTier, model: result.model, pricing: pricingNow, config });
      estimateUsd = est;
      chatEstimateUsd = sessionModel ? estimateTaskCostUsd({ tier: result.targetTier, model: sessionModel, pricing: pricingNow, config }) : null;
      const chatRate0 = blendedRatePerMillion(resolveModelPrice(sessionModel, pricingNow, { overrides: config?.pricing?.overrides }));
      const tierRate0 = blendedRatePerMillion(resolveModelPrice(result.model, pricingNow, { overrides: config?.pricing?.overrides }));
      if (chatRate0 && tierRate0) {
        multiplier = Number((tierRate0 / chatRate0).toFixed(2));
      }
      if (est !== null) {
        estimate = chatEstimateUsd !== null && chatEstimateUsd > est ? ` · est. ${formatUsd(est)} instead of ${formatUsd(chatEstimateUsd)}` : ` · est. ${formatUsd(est)}`;
      }
      const chatRate = blendedRatePerMillion(resolveModelPrice(sessionModel, pricingNow, { overrides: config?.pricing?.overrides }));
      const tierRateNow = blendedRatePerMillion(resolveModelPrice(result.model, pricingNow, { overrides: config?.pricing?.overrides }));
      if (chatRate && tierRateNow && chatRate / tierRateNow >= 1.5) {
        payoff = ` · about ${(chatRate / tierRateNow).toFixed(0)}× cheaper per token than ${sessionModel === "auto" ? "Auto's estimated rate" : sessionModel}`;
      } else if (chatRate && tierRateNow && tierRateNow / chatRate >= 1.5) {
        payoff = ` · stronger model for a risky/complex task (about ${(tierRateNow / chatRate).toFixed(0)}× the per-token price of ${sessionModel})`;
      }
    } catch {}
    const record = {
      ts: nowIso(),
      conversation_id: payload.conversation_id ?? null,
      tool_use_id: payload.tool_use_id ?? null,
      requested: result.requestedAgent,
      final: result.targetAgent,
      model: result.model,
      rewritten: result.rewritten,
      reason: result.reason,
      override: result.override,
      overrideSource: result.overrideSource,
      scores: result.scores,
      scoreSource: result.scoreSource,
      effort: result.effort,
      computedTier: result.computedTier,
      guardrail: result.guardrail,
      learning: result.learning.escalated ? result.learning.reason : null,
      description: String(payload.tool_input?.description || "").slice(0, 200),
      chatModel: sessionModel || null,
      estimateUsd,
      chatEstimateUsd,
      multiplier
    };
    if (paths && config?.enforcement?.logDecisions !== false) {
      appendJsonl(paths.decisionsPath, record);
    }
    if (workspace && payload.conversation_id) {
      if (!loadSession(workspace, payload.conversation_id)) {
        createSession({ workspace, conversationId: payload.conversation_id, model: normalizeModelId(payload.model), payload });
      }
      updateSession(workspace, payload.conversation_id, (s) => ({ delegations: [...(s.delegations || []), { ts: record.ts, agent: result.targetAgent, model: result.model, rewritten: result.rewritten }] }));
    }
    const footer = `[cco: ${result.targetTier.toUpperCase()} → ${result.model}${multiplier !== null ? ` • ${multiplier}x of ${sessionModel === "auto" ? "Auto" : "chat model"}` : ""}${estimateUsd !== null ? ` • est. ${formatUsd(estimateUsd)}` : ""}]`;
    // Per-chat budget (Copilot quota / Kilo maxCost pattern): warn, and optionally force FAST when far over.
    let budgetNote = "";
    if (workspace && payload.conversation_id && Number(config?.budget?.sessionUsd) > 0 && estimateUsd !== null) {
      const sess = loadSession(workspace, payload.conversation_id) || {};
      const spent = Number(sess.spentUsd || 0) + estimateUsd;
      updateSession(workspace, payload.conversation_id, { spentUsd: Number(spent.toFixed(3)) });
      const limit = Number(config.budget.sessionUsd);
      if (spent >= limit * Number(config.budget.warnAtFraction ?? 0.8)) {
        budgetNote = ` · budget: ${formatUsd(spent)} of $${limit.toFixed(2)} used in this chat`;
      }
      if (config.budget.enforce && spent > limit * 2 && result.targetTier !== "fast" && !(result.override && result.override !== "auto")) {
        result.targetAgent = "cco-fast";
        result.targetTier = "fast";
        result.model = readWorkspaceAgentModel(workspace, "cco-fast") || result.model;
        result.rewritten = true;
        result.reason = "budget_exceeded_force_fast";
      }
    }
    const enforce = config?.enforcement?.rewriteMisroutedTasks !== false;
    const needsScoresLine = result.updatedPrompt !== String(payload.tool_input?.prompt || "");
    if (enforce && (result.rewritten || needsScoresLine)) {
      const output = {
        permission: "allow",
        updated_input: {
          ...(payload.tool_input || {}),
          subagent_type: result.targetAgent,
          prompt: result.updatedPrompt
        }
      };
      output.agent_message = result.rewritten
        ? `CCO rerouted this delegation from ${result.requestedAgent} to ${result.targetAgent} (${result.reason}; model ${result.model}). Continue with the ${result.targetTier.toUpperCase()} result; do not re-delegate to ${result.requestedAgent}. When it returns, relay its final message verbatim without re-reading files or re-running its checks.`
        : `CCO: delegation to ${result.targetAgent} (${result.model}) logged. When it returns, relay its final message to the user verbatim (do not summarize, re-read files, or re-run its checks), then end with exactly this line: ${footer}`;
      const sessForHint = workspace && payload.conversation_id ? loadSession(workspace, payload.conversation_id) : null;
      const hint = sessForHint && !sessForHint.hintShown ? " · prefix a prompt with [cco:deep] or [cco:fast] to force a tier" : "";
      if (hint) {
        updateSession(workspace, payload.conversation_id, { hintShown: true });
      }
      output.user_message = `CCO: ${result.targetTier.toUpperCase()} tier → ${result.model}${estimate}${payoff}${budgetNote}${hint}${result.rewritten ? ` (rerouted from ${result.requestedTier.toUpperCase()}: ${result.reason})` : ""}`;
      emit(output);
      return;
    }
    emit({
      permission: "allow",
      agent_message: `CCO: delegation to ${result.targetAgent} (${result.model}) logged. When it returns, relay its final message to the user verbatim (do not summarize, re-read files, or re-run its checks), then end with exactly this line: ${footer}`,
      user_message: `CCO: ${result.targetTier.toUpperCase()} tier → ${result.model}${estimate}${payoff}${budgetNote}${(() => { const sess = workspace && payload.conversation_id ? loadSession(workspace, payload.conversation_id) : null; if (sess && !sess.hintShown) { updateSession(workspace, payload.conversation_id, { hintShown: true }); return " · prefix a prompt with [cco:deep] or [cco:fast] to force a tier"; } return ""; })()}`
    });
  } catch (error) {
    hookLog(paths, { event: "preToolUse:Task", error: String(error?.message || error) });
    emit({ permission: "allow" });
  }
}

if (isMain(import.meta.url)) {
  main().catch(() => emit({ permission: "allow" }));
}

export { CCO_AGENT_NAMES };
