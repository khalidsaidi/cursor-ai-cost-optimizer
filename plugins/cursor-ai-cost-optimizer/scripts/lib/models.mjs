import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, stripAnsi, cursorAgentBinary, readJsonSafe, TIERS, asNumber } from "./common.mjs";
import { resolveModelPrice, blendedRatePerMillion } from "./pricing.mjs";

export const CLI_CONFIG_PATH = path.join(os.homedir(), ".cursor", "cli-config.json");

/** Parse `cursor-agent models` output: lines like `composer-2.5 - Composer 2.5 (current, default)`. */
export function parseModelsOutput(stdout) {
  const models = [];
  let current = null;
  let defaultModel = null;
  for (const rawLine of stripAnsi(stdout).split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/^([a-z0-9][a-z0-9.\-\[\]=,]*)\s+-\s+(.+)$/i);
    if (!match) {
      continue;
    }
    const id = match[1];
    const labelRaw = match[2];
    const flags = labelRaw.toLowerCase();
    const isCurrent = /\(([^)]*\bcurrent\b[^)]*)\)/.test(flags);
    const isDefault = /\(([^)]*\bdefault\b[^)]*)\)/.test(flags);
    const label = labelRaw.replace(/\((?:[^)]*\b(?:current|default)\b[^)]*)\)/gi, "").trim();
    if (isCurrent) {
      current = id;
    }
    if (isDefault) {
      defaultModel = id;
    }
    models.push({ id, label, current: isCurrent, default: isDefault });
  }
  return { models, current, defaultModel };
}

export function listModels() {
  const res = run(cursorAgentBinary(), ["models"], { timeout: 30_000 });
  if (res.error || res.status !== 0) {
    return {
      ok: false,
      error: res.error ? String(res.error.message || res.error) : `exit ${res.status}: ${String(res.stderr || "").slice(0, 300)}`,
      models: [],
      current: null,
      defaultModel: null
    };
  }
  const parsed = parseModelsOutput(res.stdout);
  return { ok: parsed.models.length > 0, error: parsed.models.length ? null : "no models parsed", ...parsed };
}

/** Where the CLI binary lives (first PATH hit), so its version can be cached by file identity. */
function cliBinaryStat() {
  const bin = cursorAgentBinary();
  const candidates = path.isAbsolute(bin)
    ? [bin]
    : String(process.env.PATH || "").split(path.delimiter).filter(Boolean).flatMap((dir) =>
        process.platform === "win32" ? [path.join(dir, `${bin}.cmd`), path.join(dir, `${bin}.exe`), path.join(dir, bin)] : [path.join(dir, bin)]
      );
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      return { file: candidate, key: `${candidate}|${st.size}|${Math.floor(st.mtimeMs)}` };
    } catch {}
  }
  return null;
}

const CLI_VERSION_CACHE = path.join(os.tmpdir(), `cco-cli-version-${os.userInfo().uid ?? os.userInfo().username}.json`);

/**
 * `cursor-agent --version` costs ~0.6 s of CLI startup; hooks call this on every chat, so the answer is cached
 * per binary identity (path + size + mtime) and only re-run when the binary changes.
 */
export function cliVersion() {
  const stat = cliBinaryStat();
  if (!stat) {
    return null;
  }
  const cached = readJsonSafe(CLI_VERSION_CACHE);
  if (cached && cached.key === stat.key && cached.version) {
    return cached.version;
  }
  const res = run(cursorAgentBinary(), ["--version"], { timeout: 15_000 });
  const version = String(res.stdout || "").trim() || null;
  if (version) {
    try {
      fs.writeFileSync(CLI_VERSION_CACHE, JSON.stringify({ key: stat.key, version }), "utf8");
    } catch {}
  }
  return version;
}

/** Classify a model id by naming conventions into effort/speed attributes. */
export function classifyModel(id) {
  const lower = String(id || "").toLowerCase();
  const effortMatch = lower.match(/-(low|medium|high|xhigh|max)(?:-fast)?$/);
  return {
    id,
    effort: effortMatch ? effortMatch[1] : null,
    fast: /-fast$/.test(lower),
    thinking: /thinking/.test(lower),
    family: lower
      .replace(/-(low|medium|high|xhigh|max)(?:-fast)?$/, "")
      .replace(/-fast$/, "")
      .replace(/-thinking/, "")
  };
}

function matchesAny(id, patterns) {
  return (patterns || []).some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(id);
    } catch {
      return false;
    }
  });
}

/**
 * Rank available models for a tier: preference order from config (first pattern wins),
 * then blended price ascending inside the same preference rank. Excluded patterns are dropped.
 */
export function rankCandidates({ tier, models, pricing, config }) {
  const discovery = config?.discovery || {};
  const prefs = discovery.tierPreferences?.[tier] || [];
  const exclude = discovery.excludePatterns || [];
  const ranked = [];
  for (const model of models) {
    const id = model.id;
    if (matchesAny(id, exclude)) {
      continue;
    }
    let rank = prefs.findIndex((pattern) => {
      try {
        return new RegExp(pattern, "i").test(id);
      } catch {
        return false;
      }
    });
    if (rank < 0) {
      continue;
    }
    const price = resolveModelPrice(id, pricing, { label: model.label, overrides: config?.pricing?.overrides });
    const blended = blendedRatePerMillion(price);
    ranked.push({ id, label: model.label, rank, price, blendedRatePerMillion: blended });
  }
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    const pa = a.blendedRatePerMillion ?? Number.POSITIVE_INFINITY;
    const pb = b.blendedRatePerMillion ?? Number.POSITIVE_INFINITY;
    return pa - pb;
  });
  return ranked;
}

export function detectProbeFailure(stderr, stdout) {
  const text = `${stderr || ""}\n${stdout || ""}`;
  if (/usage limit|rate limit|quota/i.test(text)) {
    return "usage_limit";
  }
  if (/authentication required|not logged in|unauthenticated/i.test(text)) {
    return "auth_required";
  }
  if (/workspace trust/i.test(text)) {
    return "workspace_trust";
  }
  if (/not available|unavailable|not found|unknown model|invalid model/i.test(text)) {
    return "model_unavailable";
  }
  if (/timed? ?out/i.test(text)) {
    return "timeout";
  }
  return "execution_error";
}

/** Run a tiny read-only prompt to verify a model actually executes for this account. */
export function probeModel(modelId, workspace, { timeoutMs = 60_000 } = {}) {
  const marker = "CCO_MODEL_PROBE_OK";
  const res = run(
    cursorAgentBinary(),
    [
      "--model",
      modelId,
      "--trust",
      "--mode",
      "ask",
      "-p",
      "--output-format",
      "json",
      "--workspace",
      workspace,
      `Reply with exactly this text and nothing else: ${marker}`
    ],
    { timeout: timeoutMs }
  );
  const stdout = String(res.stdout || "");
  const stderr = String(res.stderr || "");
  let usage = null;
  let resultText = "";
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "result") {
        usage = parsed.usage || null;
        resultText = String(parsed.result || "");
        break;
      }
    } catch {}
  }
  const ok = res.status === 0 && new RegExp(`\\b${marker}\\b`).test(resultText || stdout);
  if (ok) {
    return { runnable: true, reason: "ok", status: res.status, usage };
  }
  return {
    runnable: false,
    reason: res.error?.code === "ETIMEDOUT" ? "timeout" : detectProbeFailure(stderr, stdout),
    status: res.status,
    stderr: stderr.trim().slice(0, 400),
    stdout: stdout.trim().slice(0, 400)
  };
}

/** Snapshot the user's CLI model selection so probes (which persist --model) can be undone. */
export function snapshotCliModel() {
  const cfg = readJsonSafe(CLI_CONFIG_PATH);
  if (!cfg) {
    return null;
  }
  return {
    model: cfg.model ?? null,
    modelParameters: cfg.modelParameters ?? null,
    hasChangedDefaultModel: cfg.hasChangedDefaultModel ?? null
  };
}

export function restoreCliModel(snapshot) {
  if (!snapshot) {
    return { restored: false, reason: "no_snapshot" };
  }
  const cfg = readJsonSafe(CLI_CONFIG_PATH);
  if (!cfg) {
    return { restored: false, reason: "no_cli_config" };
  }
  const next = { ...cfg };
  if (snapshot.model !== null) {
    next.model = snapshot.model;
  }
  if (snapshot.modelParameters !== null) {
    next.modelParameters = snapshot.modelParameters;
  }
  if (snapshot.hasChangedDefaultModel !== null) {
    next.hasChangedDefaultModel = snapshot.hasChangedDefaultModel;
  }
  try {
    fs.writeFileSync(CLI_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return { restored: true, model: snapshot.model?.modelId ?? null };
  } catch (error) {
    return { restored: false, reason: String(error?.message || error) };
  }
}

export function currentCliModelId() {
  const cfg = readJsonSafe(CLI_CONFIG_PATH);
  const id = cfg?.model?.modelId;
  if (!id) {
    return null;
  }
  const params = cfg?.modelParameters?.[id];
  const fast = Array.isArray(params) && params.some((p) => p?.id === "fast" && String(p.value) === "true");
  const effort = Array.isArray(params) ? params.find((p) => p?.id === "effort")?.value : null;
  let full = id;
  if (effort && !/-(low|medium|high|xhigh|max)$/.test(id)) {
    full = `${full}-${effort}`;
  }
  if (fast && !/-fast$/.test(full)) {
    full = `${full}-fast`;
  }
  return full;
}

export function tierFor(name) {
  const lower = String(name || "").toLowerCase();
  return TIERS.find((tier) => lower === tier || lower === `cco-${tier}`) || null;
}

export function priceSummary(price) {
  if (!price || !Number.isFinite(price.input)) {
    return "price unknown";
  }
  return `$${price.input}/M in, $${price.output}/M out`;
}

export function safeCount(value) {
  return asNumber(value, 0);
}
