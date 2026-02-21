#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PLUGIN_DEFAULTS_PATH = path.join(
  process.cwd(),
  "plugins/cursor-ai-cost-optimizer/config/defaults.json"
);
const DEFAULT_STATE_REL_PATH = path.join(".cursor", "cco-joint-state.json");

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function deepMerge(base, override) {
  if (!override || typeof override !== "object") {
    return base;
  }
  if (!base || typeof base !== "object") {
    return override;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = deepMerge(base[key] || {}, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toZScores(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(values.length, 1);
  const std = Math.sqrt(variance);
  if (std <= 1e-9) {
    return values.map(() => 0);
  }
  return values.map((value) => (value - mean) / std);
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function normalizeByRange(value, min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return 0.5;
  }
  return clamp((value - min) / (max - min), 0, 1);
}

function modelCapabilityRiskAdjustment(modelId, jointCfg) {
  const id = String(modelId || "").toLowerCase();
  const highKeywords = jointCfg?.modelRiskAdjustment?.highCapabilityKeywords || [];
  const lowKeywords = jointCfg?.modelRiskAdjustment?.lowCapabilityKeywords || [];
  const highDelta = asNumber(jointCfg?.modelRiskAdjustment?.highDelta, -0.05);
  const lowDelta = asNumber(jointCfg?.modelRiskAdjustment?.lowDelta, 0.05);

  if (highKeywords.some((keyword) => id.includes(String(keyword).toLowerCase()))) {
    return highDelta;
  }
  if (lowKeywords.some((keyword) => id.includes(String(keyword).toLowerCase()))) {
    return lowDelta;
  }
  return 0;
}

function inferModelPriceMultiplier(modelId, overrides = {}) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, modelId)) {
    return clamp(asNumber(overrides[modelId], 1), 0.1, 8);
  }

  const id = String(modelId || "").toLowerCase();
  if (!id || id === "auto") {
    return 1.0;
  }
  if (id.includes("xhigh") || id.includes("opus") || id.includes("thinking")) {
    return 2.1;
  }
  if (id.includes("high")) {
    return 1.6;
  }
  if (id.includes("fast") || id.includes("flash") || id.includes("mini") || id.includes("low")) {
    return 0.7;
  }
  return 1.0;
}

function normalizeTier(tier) {
  const value = String(tier || "").toLowerCase();
  if (value === "fast" || value === "balanced" || value === "deep") {
    return value;
  }
  return "balanced";
}

function normalizeScores(raw) {
  const scores = raw || {};
  return {
    complexity: clamp(asNumber(scores.complexity, 0), 0, 10),
    risk: clamp(asNumber(scores.risk, 0), 0, 10),
    uncertainty: clamp(asNumber(scores.uncertainty, 0), 0, 10),
    breadth: clamp(asNumber(scores.breadth, 0), 0, 10),
    latency: clamp(asNumber(scores.latency, 0), 0, 10)
  };
}

function parseOverrideTier(prompt, overrideTokens) {
  const text = String(prompt || "").toLowerCase();
  const normalized = overrideTokens || {};
  const entries = [
    ["fast", normalized.fast || "[cco:fast]"],
    ["balanced", normalized.balanced || "[cco:balanced]"],
    ["deep", normalized.deep || "[cco:deep]"],
    ["auto", normalized.auto || "[cco:auto]"]
  ];
  for (const [tier, token] of entries) {
    if (!token) {
      continue;
    }
    if (text.includes(String(token).toLowerCase())) {
      return tier;
    }
  }
  return null;
}

function baselineEffort(scores, weights) {
  return (
    asNumber(weights?.complexity, 0.45) * scores.complexity +
    asNumber(weights?.risk, 0.35) * scores.risk +
    asNumber(weights?.breadth, 0.15) * scores.breadth +
    asNumber(weights?.uncertainty, 0.1) * scores.uncertainty +
    asNumber(weights?.latency, -0.2) * scores.latency
  );
}

export function loadMergedConfig({ workspace, defaultsPath = DEFAULT_PLUGIN_DEFAULTS_PATH }) {
  const defaults = readJsonSafe(defaultsPath) || {};
  const userConfigPath = path.join(workspace, ".cursor", "cco.json");
  const userConfig = readJsonSafe(userConfigPath) || {};
  const merged = deepMerge(defaults, userConfig);
  return {
    defaultsPath,
    userConfigPath,
    config: merged
  };
}

export function defaultJointState() {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    observations: {}
  };
}

export function loadJointState({ workspace, statePath }) {
  const finalPath = statePath || path.join(workspace, DEFAULT_STATE_REL_PATH);
  const loaded = readJsonSafe(finalPath);
  if (!loaded || typeof loaded !== "object") {
    return { statePath: finalPath, state: defaultJointState() };
  }
  return { statePath: finalPath, state: loaded };
}

export function saveJointState({ statePath, state }) {
  ensureDir(path.dirname(statePath));
  const payload = {
    ...state,
    schemaVersion: 1,
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function getTierPrior(jointCfg, tier) {
  const priorsByTier = jointCfg?.priorsByTier || {};
  const prior = priorsByTier[tier] || priorsByTier.balanced || {};
  return {
    durationApiMs: asNumber(prior.durationApiMs, tier === "fast" ? 2600 : tier === "deep" ? 6000 : 4200),
    thinkingChars: asNumber(prior.thinkingChars, tier === "fast" ? 240 : tier === "deep" ? 1300 : 650),
    assistantChars: asNumber(prior.assistantChars, tier === "fast" ? 320 : tier === "deep" ? 1200 : 700),
    errorRate: clamp(asNumber(prior.errorRate, tier === "deep" ? 0.03 : tier === "fast" ? 0.06 : 0.045), 0, 1),
    reworkRate: clamp(asNumber(prior.reworkRate, tier === "deep" ? 0.05 : tier === "fast" ? 0.09 : 0.07), 0, 1),
    modeCostMultiplier: clamp(asNumber(prior.modeCostMultiplier, tier === "fast" ? 0.85 : tier === "deep" ? 1.2 : 1), 0.25, 5),
    inputOverheadChars: asNumber(prior.inputOverheadChars, tier === "deep" ? 340 : 170)
  };
}

function getObservation(state, model, tier) {
  const key = `${model}|${tier}`;
  const obs = state?.observations?.[key];
  if (!obs || typeof obs !== "object") {
    return { key, count: 0 };
  }
  return {
    key,
    count: asNumber(obs.count, 0),
    emaCostUsd: asNumber(obs.emaCostUsd, NaN),
    emaDurationApiMs: asNumber(obs.emaDurationApiMs, NaN),
    emaErrorRate: clamp(asNumber(obs.emaErrorRate, NaN), 0, 1),
    emaReworkRate: clamp(asNumber(obs.emaReworkRate, NaN), 0, 1),
    emaThinkingChars: asNumber(obs.emaThinkingChars, NaN),
    emaAssistantChars: asNumber(obs.emaAssistantChars, NaN),
    lastUpdated: obs.lastUpdated || null
  };
}

function getPricingRates(pricingData) {
  const fromPerToken = pricingData?.autoApiRatesUsdPerToken;
  if (fromPerToken && Number.isFinite(Number(fromPerToken.inputCacheWrite)) && Number.isFinite(Number(fromPerToken.output))) {
    return {
      input: asNumber(fromPerToken.inputCacheWrite, 0),
      output: asNumber(fromPerToken.output, 0)
    };
  }
  const per1m = pricingData?.autoApiRatesUsdPer1MTokens;
  if (per1m && Number.isFinite(Number(per1m.inputCacheWrite)) && Number.isFinite(Number(per1m.output))) {
    return {
      input: asNumber(per1m.inputCacheWrite, 0) / 1_000_000,
      output: asNumber(per1m.output, 0) / 1_000_000
    };
  }
  return null;
}

function adaptiveWeights(scores, jointCfg) {
  const low = jointCfg?.adaptiveWeights?.lowRisk || { cost: 0.5, risk: 0.3, latency: 0.2 };
  const high = jointCfg?.adaptiveWeights?.highRisk || { cost: 0.2, risk: 0.6, latency: 0.2 };
  const riskNorm = clamp(scores.risk / 10, 0, 1);

  const cost = asNumber(low.cost, 0.5) + (asNumber(high.cost, 0.2) - asNumber(low.cost, 0.5)) * riskNorm;
  const risk = asNumber(low.risk, 0.3) + (asNumber(high.risk, 0.6) - asNumber(low.risk, 0.3)) * riskNorm;
  const latency =
    asNumber(low.latency, 0.2) +
    (asNumber(high.latency, 0.2) - asNumber(low.latency, 0.2)) * riskNorm;

  const sum = cost + risk + latency;
  if (sum <= 0) {
    return { cost: 0.5, risk: 0.3, latency: 0.2 };
  }
  return {
    cost: cost / sum,
    risk: risk / sum,
    latency: latency / sum
  };
}

function coalesce(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function candidateRiskHat({ scores, candidate, observation, jointCfg }) {
  const fuzzy =
    (0.35 * scores.risk + 0.25 * scores.complexity + 0.2 * scores.uncertainty + 0.2 * scores.breadth) / 10;
  const empirical = clamp(
    0.7 * coalesce(observation.emaErrorRate, candidate.predicted.errorRate) +
      0.3 * coalesce(observation.emaReworkRate, candidate.predicted.reworkRate),
    0,
    1
  );
  const tierAdjust =
    asNumber(jointCfg?.tierRiskAdjustment?.[candidate.tier], candidate.tier === "fast" ? 0.12 : candidate.tier === "deep" ? -0.05 : 0.04);
  const modelAdjust = modelCapabilityRiskAdjustment(candidate.model, jointCfg);
  const riskScale = clamp(scores.risk / 10, 0, 1);
  return clamp(0.65 * fuzzy + 0.35 * empirical + (tierAdjust + modelAdjust) * riskScale, 0, 1);
}

function asRanking(items, key) {
  return [...items].sort((a, b) => asNumber(a[key], 0) - asNumber(b[key], 0));
}

function minMax(values) {
  if (!values.length) {
    return { min: 0, max: 1 };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

export function scoreJointCandidates({
  task,
  candidates,
  state,
  config,
  pricing
}) {
  const jointCfg = config?.jointScoring || {};
  const scores = normalizeScores(task?.scores || {});
  const promptChars = asNumber(task?.promptChars, String(task?.prompt || "").length);
  const pricingRates = getPricingRates(pricing);
  const weights = adaptiveWeights(scores, jointCfg);

  const predicted = candidates.map((candidate) => {
    const tier = normalizeTier(candidate.tier);
    const model = String(candidate.model || "auto");
    const prior = getTierPrior(jointCfg, tier);
    const observation = getObservation(state, model, tier);
    const modelMultiplier = inferModelPriceMultiplier(
      model,
      jointCfg?.modelPriceMultipliers || {}
    );

    const durationApiMs = coalesce(observation.emaDurationApiMs, prior.durationApiMs);
    const thinkingChars = coalesce(observation.emaThinkingChars, prior.thinkingChars);
    const assistantChars = coalesce(observation.emaAssistantChars, prior.assistantChars);
    const errorRate = coalesce(observation.emaErrorRate, prior.errorRate);
    const reworkRate = coalesce(observation.emaReworkRate, prior.reworkRate);

    const predictedInputTokens = (promptChars + prior.inputOverheadChars) / 4;
    const predictedOutputTokens = (assistantChars + 0.6 * thinkingChars) / 4;
    const priceCostRaw = pricingRates
      ? (predictedInputTokens * pricingRates.input + predictedOutputTokens * pricingRates.output) *
        modelMultiplier *
        prior.modeCostMultiplier
      : modelMultiplier * prior.modeCostMultiplier;

    return {
      ...candidate,
      tier,
      model,
      observation,
      modelMultiplier,
      predicted: {
        durationApiMs,
        thinkingChars,
        assistantChars,
        errorRate,
        reworkRate,
        priceCostRaw
      }
    };
  });

  const durations = predicted.map((entry) => entry.predicted.durationApiMs);
  const thinking = predicted.map((entry) => entry.predicted.thinkingChars);
  const assistant = predicted.map((entry) => entry.predicted.assistantChars);
  const errors = predicted.map((entry) => clamp(entry.predicted.errorRate + entry.predicted.reworkRate, 0, 1));
  const prices = predicted.map((entry) => entry.predicted.priceCostRaw);

  const zDur = toZScores(durations).map(sigmoid);
  const zThink = toZScores(thinking).map(sigmoid);
  const zAssist = toZScores(assistant).map(sigmoid);
  const zErr = toZScores(errors).map(sigmoid);
  const mmPrice = minMax(prices);
  const mmDur = minMax(durations);

  const costBlend = jointCfg?.costBlend || {};
  const priceWeight = clamp(asNumber(costBlend.pricePrior, 0.6), 0, 1);
  const fieldWeight = clamp(asNumber(costBlend.fieldProxy, 0.4), 0, 1);
  const normFactor = priceWeight + fieldWeight || 1;

  const fieldProxyWeights = jointCfg?.fieldProxyWeights || {};
  const fpDuration = asNumber(fieldProxyWeights.durationApiMs, 0.35);
  const fpThinking = asNumber(fieldProxyWeights.thinkingChars, 0.25);
  const fpAssistant = asNumber(fieldProxyWeights.assistantChars, 0.2);
  const fpError = asNumber(fieldProxyWeights.errorPenalty, 0.2);
  const fpSum = fpDuration + fpThinking + fpAssistant + fpError || 1;

  const scored = predicted.map((entry, index) => {
    const C_price_prior = normalizeByRange(entry.predicted.priceCostRaw, mmPrice.min, mmPrice.max);
    const C_field_proxy =
      (fpDuration * zDur[index] +
        fpThinking * zThink[index] +
        fpAssistant * zAssist[index] +
        fpError * zErr[index]) /
      fpSum;
    const C_hat = (priceWeight * C_price_prior + fieldWeight * C_field_proxy) / normFactor;
    const R_hat = candidateRiskHat({
      scores,
      candidate: entry,
      observation: entry.observation,
      jointCfg
    });
    const L_hat = normalizeByRange(entry.predicted.durationApiMs, mmDur.min, mmDur.max);

    const totalLoss = weights.cost * C_hat + weights.risk * R_hat + weights.latency * L_hat;
    const highRiskThreshold = clamp(asNumber(jointCfg?.safetyGuard?.highRiskThreshold, 7), 0, 10);
    const maxRiskHatHighRisk = clamp(asNumber(jointCfg?.safetyGuard?.maxRiskHatHighRisk, 0.55), 0.05, 1);
    const criticalRiskForceDeepThreshold = clamp(
      asNumber(jointCfg?.safetyGuard?.criticalRiskForceDeepThreshold, 9),
      0,
      10
    );
    const highRisk = scores.risk >= highRiskThreshold;
    const criticalRisk = scores.risk >= criticalRiskForceDeepThreshold;
    let feasible = !(highRisk && R_hat > maxRiskHatHighRisk);
    if (highRisk && entry.tier === "fast") {
      feasible = false;
    }
    if (criticalRisk && entry.tier !== "deep") {
      feasible = false;
    }

    return {
      model: entry.model,
      tier: entry.tier,
      totalLoss,
      feasible,
      components: {
        C_hat,
        C_price_prior,
        C_field_proxy,
        R_hat,
        L_hat
      },
      predicted: entry.predicted,
      weights,
      observationCount: entry.observation.count
    };
  });

  const ranked = asRanking(scored, "totalLoss");
  return {
    ranked,
    weights,
    scores
  };
}

export function selectJointCandidate({
  task,
  runtime,
  state,
  config,
  pricing,
  candidates
}) {
  const overrideTier = parseOverrideTier(task?.prompt || "", config?.overrideTokens || {});
  const chosenCandidates = Array.isArray(candidates) && candidates.length ? candidates : buildCandidates(runtime);
  const scored = scoreJointCandidates({
    task,
    candidates: chosenCandidates,
    state,
    config,
    pricing
  });

  let pool = scored.ranked;
  let reason = "lowest_total_loss";
  if (overrideTier && overrideTier !== "auto") {
    pool = scored.ranked.filter((entry) => entry.tier === overrideTier);
    reason = `override_${overrideTier}`;
  }

  let selected = pool.find((entry) => entry.feasible);
  if (overrideTier && overrideTier !== "auto") {
    selected = [...pool]
      .sort((a, b) => asNumber(a?.components?.C_hat, 0) - asNumber(b?.components?.C_hat, 0))[0];
    reason = `${reason}_cheapest`;
  }
  if (!selected) {
    selected = [...(pool.length ? pool : scored.ranked)].sort(
      (a, b) => asNumber(a?.components?.R_hat, 0) - asNumber(b?.components?.R_hat, 0)
    )[0];
    reason = `${reason}_fallback_lowest_risk`;
  }
  return {
    selected,
    ranked: scored.ranked,
    reason,
    overrideTier,
    adaptiveWeights: scored.weights,
    normalizedScores: scored.scores
  };
}

export function buildCandidates(runtime) {
  const profiles = runtime?.profiles || {};
  const models = new Set([
    profiles.fast?.model || "auto",
    profiles.balanced?.model || "auto",
    profiles.deep?.model || "auto",
    "auto"
  ]);
  const candidates = [];
  for (const tier of ["fast", "balanced", "deep"]) {
    for (const model of models) {
      candidates.push({ model, tier });
    }
  }
  return candidates;
}

export function selectBaselineCandidate({ task, runtime, config }) {
  const overrideTier = parseOverrideTier(task?.prompt || "", config?.overrideTokens || {});
  const scores = normalizeScores(task?.scores || {});
  const effort = baselineEffort(scores, config?.weights || {});

  let tier = "balanced";
  if (scores.risk >= 7) {
    tier = "deep";
  } else if (scores.latency >= 7 && scores.risk <= 3 && scores.complexity <= 3) {
    tier = "fast";
  } else if (effort <= asNumber(config?.thresholds?.fastMax, 3.4)) {
    tier = "fast";
  } else if (effort >= asNumber(config?.thresholds?.balancedMax, 6.4) + 0.1) {
    tier = "deep";
  }

  if (overrideTier && overrideTier !== "auto") {
    tier = overrideTier;
  }

  const model = runtime?.profiles?.[tier]?.model || "auto";
  return {
    model,
    tier,
    effort,
    overrideTier,
    scores
  };
}

function ema(prev, next, alpha) {
  if (!Number.isFinite(prev)) {
    return next;
  }
  return alpha * next + (1 - alpha) * prev;
}

export function updateJointState({
  state,
  model,
  tier,
  observation,
  config
}) {
  const next = state && typeof state === "object" ? { ...state } : defaultJointState();
  if (!next.observations || typeof next.observations !== "object") {
    next.observations = {};
  }
  const key = `${model}|${normalizeTier(tier)}`;
  const prev = next.observations[key] || { count: 0 };
  const alpha = clamp(asNumber(config?.jointScoring?.ema?.alpha, 0.25), 0.01, 1);

  const value = {
    count: asNumber(prev.count, 0) + 1,
    emaCostUsd: ema(asNumber(prev.emaCostUsd, NaN), asNumber(observation.estimatedCostUsd, 0), alpha),
    emaDurationApiMs: ema(
      asNumber(prev.emaDurationApiMs, NaN),
      asNumber(observation.durationApiMs, 0),
      alpha
    ),
    emaErrorRate: ema(
      clamp(asNumber(prev.emaErrorRate, NaN), 0, 1),
      observation.isError ? 1 : 0,
      alpha
    ),
    emaReworkRate: ema(
      clamp(asNumber(prev.emaReworkRate, NaN), 0, 1),
      observation.rework ? 1 : 0,
      alpha
    ),
    emaThinkingChars: ema(
      asNumber(prev.emaThinkingChars, NaN),
      asNumber(observation.thinkingChars, 0),
      alpha
    ),
    emaAssistantChars: ema(
      asNumber(prev.emaAssistantChars, NaN),
      asNumber(observation.assistantChars, 0),
      alpha
    ),
    lastUpdated: new Date().toISOString()
  };

  next.observations[key] = value;
  next.generatedAt = new Date().toISOString();
  return next;
}

export function estimateObservedCostUsd({
  pricing,
  promptChars,
  thinkingChars,
  assistantChars,
  model,
  tier,
  config
}) {
  const pricingRates = getPricingRates(pricing);
  if (!pricingRates) {
    return 0;
  }
  const jointCfg = config?.jointScoring || {};
  const prior = getTierPrior(jointCfg, normalizeTier(tier));
  const modelMultiplier = inferModelPriceMultiplier(model, jointCfg?.modelPriceMultipliers || {});
  const inputTokens = (asNumber(promptChars, 0) + prior.inputOverheadChars) / 4;
  const outputTokens = (asNumber(assistantChars, 0) + 0.6 * asNumber(thinkingChars, 0)) / 4;
  const raw =
    (inputTokens * pricingRates.input + outputTokens * pricingRates.output) *
    modelMultiplier *
    prior.modeCostMultiplier;
  return Math.max(0, raw);
}
