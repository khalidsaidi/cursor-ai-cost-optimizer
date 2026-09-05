import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, asNumber } from "./common.mjs";
import { resolveModelPrice } from "./pricing.mjs";

/** Detect the project's cheapest acceptance test command, if any. */
export function detectTestCommand(workspace) {
  if (!workspace) {
    return null;
  }
  const pkg = readJsonSafe(path.join(workspace, "package.json"));
  if (pkg?.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) {
    const pm = fs.existsSync(path.join(workspace, "pnpm-lock.yaml")) ? "pnpm" : fs.existsSync(path.join(workspace, "yarn.lock")) ? "yarn" : fs.existsSync(path.join(workspace, "bun.lockb")) || fs.existsSync(path.join(workspace, "bun.lock")) ? "bun" : "npm";
    return { command: `${pm} test`, kind: "package-script" };
  }
  for (const dir of ["test", "tests", "__tests__"]) {
    const full = path.join(workspace, dir);
    try {
      if (fs.readdirSync(full).some((f) => /\.test\.(mjs|cjs|js|ts)$/.test(f))) {
        // no directory argument: Node 18/20/22 all discover test files themselves (Node 22 no longer accepts a directory)
        return { command: "node --test", kind: "node-test" };
      }
    } catch {}
  }
  if (fs.existsSync(path.join(workspace, "pytest.ini")) || fs.existsSync(path.join(workspace, "pyproject.toml")) || fs.existsSync(path.join(workspace, "tests"))) {
    if (fs.existsSync(path.join(workspace, "pytest.ini")) || fs.existsSync(path.join(workspace, "pyproject.toml"))) {
      return { command: "pytest -q", kind: "pytest" };
    }
  }
  if (fs.existsSync(path.join(workspace, "Cargo.toml"))) {
    return { command: "cargo test", kind: "cargo" };
  }
  if (fs.existsSync(path.join(workspace, "go.mod"))) {
    return { command: "go test ./...", kind: "go" };
  }
  return null;
}

/** Rough expected cost of a task on a tier's model, from the tier's expected token volume. */
/**
 * Estimated cost of a tier's typical task on a model. A delegation is a fresh session: it writes the whole
 * system context (rules, tool schemas, ~38k tokens measured) to the cache once, so its estimate carries that
 * start-up cost; the chat's own session already has it and pays nothing extra.
 */
/** Output-token multiplier for a model id's effort level and thinking variant (config `budgets.effortOutputFactor`). */
export function effortOutputFactor(modelId, config) {
  const table = { low: 0.7, medium: 1.0, high: 1.5, xhigh: 2.0, max: 3.0, thinking: 1.3, ...(config?.budgets?.effortOutputFactor || {}) };
  const id = String(modelId || "").toLowerCase();
  const m = id.match(/-(low|medium|high|xhigh|max)(?:-fast)?$/);
  let factor = m ? asNumber(table[m[1]], 1) : 1;
  if (/thinking/.test(id)) {
    factor *= asNumber(table.thinking, 1);
  }
  return factor;
}

export function estimateTaskCostUsd({ tier, model, pricing, config, delegation = false }) {
  const price = resolveModelPrice(model, pricing, { overrides: config?.pricing?.overrides });
  const expected = config?.budgets?.[tier]?.expectedTokens;
  if (!price || !Number.isFinite(price.input) || !expected) {
    return null;
  }
  const input = asNumber(expected.input, 0);
  // Reasoning effort is paid in output tokens: the same model at "high" writes about 1.5x the tokens of "medium",
  // "thinking" variants more still. That is the lever Auto never pulls: Balanced work runs at medium.
  const output = asNumber(expected.output, 0) * effortOutputFactor(model, config);
  // Most input is cache reads in a multi-turn subagent session.
  let usd = (input * (0.2 * price.input + 0.8 * price.cacheRead) + output * price.output) / 1_000_000;
  if (delegation) {
    const overheadTokens = asNumber(config?.budgets?.sessionOverheadTokens, 38000);
    const writeRate = Number.isFinite(price.cacheWrite) ? price.cacheWrite : price.input;
    usd += (overheadTokens * writeRate) / 1_000_000;
  }
  return Number(usd.toFixed(3));
}

/**
 * Is a delegation of this tier's task to `tierModel` worth it next to doing it in the chat on `sessionModel`?
 * Compares whole-task estimates (the delegation's session start included) against the configured minimum
 * savings factor. Returns nulls when a price is unknown.
 */
export function delegationWorth({ tier, tierModel, sessionModel, pricing, config }) {
  // Auto (or an unknown chat model) has no price of its own: Cursor bills whatever it picked. Until a hook payload
  // names that model, the parent's own routing choice stands (nothing is denied on a guess).
  const sessionPrice = sessionModel ? resolveModelPrice(sessionModel, pricing, { overrides: config?.pricing?.overrides }) : null;
  if (!sessionPrice || sessionPrice.confidence === "estimate" || sessionPrice.confidence === "unknown") {
    return { known: false, worth: null, tierCost: null, chatCost: null, factor: null };
  }
  const tierCost = tierModel && tierModel !== "inherit" ? estimateTaskCostUsd({ tier, model: tierModel, pricing, config, delegation: true }) : null;
  const chatCost = sessionModel ? estimateTaskCostUsd({ tier, model: sessionModel, pricing, config }) : null;
  const minSavings = asNumber(config?.enforcement?.minSavingsFactor, 1.3);
  if (tierCost === null || chatCost === null || tierCost <= 0) {
    return { known: false, worth: null, tierCost, chatCost, factor: null };
  }
  const factor = chatCost / tierCost;
  return { known: true, worth: factor >= minSavings, tierCost, chatCost, factor: Number(factor.toFixed(2)), savings: Number((chatCost - tierCost).toFixed(3)) };
}

export function formatUsd(usd) {
  if (usd === null || usd === undefined) {
    return "";
  }
  return usd < 0.01 ? "<$0.01" : `~$${usd.toFixed(2)}`;
}
