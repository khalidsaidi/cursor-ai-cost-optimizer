import path from "node:path";
import { readJsonSafe, writeJson, nowIso, clamp, asNumber, TIERS } from "./common.mjs";

export function defaultJointState() {
  return { schemaVersion: 2, generatedAt: nowIso(), tiers: {}, models: {} };
}

export function loadJointState(statePath) {
  const data = readJsonSafe(statePath);
  if (!data || typeof data !== "object") {
    return defaultJointState();
  }
  return { ...defaultJointState(), ...data, tiers: data.tiers || {}, models: data.models || {} };
}

function ema(prev, next, alpha) {
  if (!Number.isFinite(prev)) {
    return next;
  }
  return alpha * next + (1 - alpha) * prev;
}

/**
 * Record one observed subagent outcome for a tier/model.
 * observation: { isError, rework, durationMs, costUsd }
 */
export function recordOutcome({ state, tier, model, observation, config = {} }) {
  const next = state && typeof state === "object" ? { ...state } : defaultJointState();
  next.tiers = { ...(next.tiers || {}) };
  next.models = { ...(next.models || {}) };
  const alpha = clamp(asNumber(config?.learning?.emaAlpha, 0.25), 0.01, 1);
  const update = (bucket, key) => {
    const prev = bucket[key] || { count: 0 };
    bucket[key] = {
      count: asNumber(prev.count, 0) + 1,
      emaError: ema(asNumber(prev.emaError, NaN), observation.isError ? 1 : 0, alpha),
      emaRework: ema(asNumber(prev.emaRework, NaN), observation.rework ? 1 : 0, alpha),
      emaDurationMs: ema(asNumber(prev.emaDurationMs, NaN), asNumber(observation.durationMs, 0), alpha),
      emaCostUsd: Number.isFinite(observation.costUsd)
        ? ema(asNumber(prev.emaCostUsd, NaN), observation.costUsd, alpha)
        : asNumber(prev.emaCostUsd, NaN) || null,
      lastUpdated: nowIso()
    };
    if (!Number.isFinite(bucket[key].emaCostUsd)) {
      bucket[key].emaCostUsd = null;
    }
  };
  if (TIERS.includes(tier)) {
    update(next.tiers, tier);
  }
  if (model && model !== "inherit") {
    update(next.models, model);
  }
  next.generatedAt = nowIso();
  return next;
}

export function saveJointState(statePath, state) {
  try {
    writeJson(statePath, state);
    return true;
  } catch {
    return false;
  }
}

/** Cooldowns live in their own small file: several hooks write joint-state.json at once, and a limit must not be lost to that race. */
export function limitsPathFor(jointStatePath) {
  return path.join(path.dirname(jointStatePath), "model-limits.json");
}

export function loadLimits(limitsPath) {
  return readJsonSafe(limitsPath) || {};
}

/** A model that could not even start a subagent (usage limit / not available) is skipped for a while. */
export function markModelLimited({ limitsPath, model, minutes = 360, reason = "startup_failure" }) {
  if (!limitsPath || !model || model === "inherit") {
    return null;
  }
  const limits = loadLimits(limitsPath);
  const prev = limits[model] || {};
  limits[model] = {
    until: new Date(Date.now() + minutes * 60_000).toISOString(),
    reason,
    at: nowIso(),
    failures: asNumber(prev.failures, 0) + 1,
    firstFailureAt: prev.firstFailureAt || nowIso()
  };
  try {
    writeJson(limitsPath, limits);
  } catch {}
  return limits[model];
}

/** ISO time until which `model` is on cooldown, or null when it is usable. */
export function modelLimitedUntil(limitsPath, model) {
  const entry = limitsPath ? loadLimits(limitsPath)[model] : null;
  if (!entry?.until) {
    return null;
  }
  return Date.parse(entry.until) > Date.now() ? entry.until : null;
}

const UNAVAILABLE_FAILURES = 3;
const UNAVAILABLE_SPAN_HOURS = 12;

/**
 * A model that keeps refusing to start across cooldown periods is not a usage limit but a plan/team restriction
 * or a disabled model: it is treated as unavailable and discovery maps its tier to the next candidate.
 */
export function modelUnavailable(limitsPath, model) {
  const entry = limitsPath ? loadLimits(limitsPath)[model] : null;
  if (!entry) {
    return false;
  }
  const span = Date.now() - Date.parse(entry.firstFailureAt || entry.at || 0);
  return asNumber(entry.failures, 0) >= UNAVAILABLE_FAILURES && span >= UNAVAILABLE_SPAN_HOURS * 3_600_000;
}

export function unavailableModels(limitsPath) {
  return Object.keys(loadLimits(limitsPath)).filter((m) => modelUnavailable(limitsPath, m));
}
