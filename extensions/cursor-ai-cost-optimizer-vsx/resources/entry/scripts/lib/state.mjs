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
