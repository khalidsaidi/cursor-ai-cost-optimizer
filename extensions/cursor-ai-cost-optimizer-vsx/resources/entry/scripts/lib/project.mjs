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

/**
 * Turn multiplier for a model id (config `budgets.turnFactor`): every request re-reads the whole context, so a model
 * that takes more requests for the same task bills more cache reads. In the IDE every model measured took the same
 * turns (Grok 4.6 High and Auto both 98k cache reads on the same task), so the defaults are 1.
 */
export function turnFactor(modelId, config) {
  const table = { high: 1, xhigh: 1, max: 1, thinking: 1, ...(config?.budgets?.turnFactor || {}) };
  const id = String(modelId || "").toLowerCase();
  const m = id.match(/-(low|medium|high|xhigh|max)(?:-fast)?$/);
  let factor = m ? asNumber(table[m[1]], 1) : 1;
  if (/thinking/.test(id) && !m) {
    factor = asNumber(table.thinking, 1);
  }
  return factor;
}

const DEFAULT_PROFILE = { fast: { subagent: { input: 18000, output: 3000, cacheRead: 120000 }, chat: { input: 3000, output: 1500, cacheRead: 98000 } }, balanced: { scale: 2.5 }, deep: { scale: 6.7 } };
const DEFAULT_PARENT_OVERHEAD = { input: 2800, output: 700, cacheRead: 48000 };

/** Token volume one task of `tier` bills, done by the tier subagent (`delegation`) or in the chat. */
export function taskTokens({ tier, config, delegation = false }) {
  const profile = { ...DEFAULT_PROFILE, ...(config?.budgets?.taskProfile || {}) };
  const base = profile.fast?.[delegation ? "subagent" : "chat"] || DEFAULT_PROFILE.fast[delegation ? "subagent" : "chat"];
  const scale = tier === "fast" ? 1 : asNumber(profile[tier]?.scale, DEFAULT_PROFILE[tier]?.scale ?? 1);
  return { input: asNumber(base.input, 0) * scale, output: asNumber(base.output, 0) * scale, cacheRead: asNumber(base.cacheRead, 0) * scale };
}

function usdFor(tokens, price, model, config) {
  const turns = turnFactor(model, config);
  const output = tokens.output * effortOutputFactor(model, config);
  return (tokens.input * turns * price.input + tokens.cacheRead * turns * price.cacheRead + output * price.output) / 1_000_000;
}

/**
 * Estimated cost of one task of `tier` on `model`: in the tier subagent's own session (`delegation`, its whole
 * session included) or done in an ongoing chat. Calibrated on Cursor's bill: cache reads are the largest line
 * (each request re-reads the context), so a model's turn count matters as much as its rates.
 */
export function estimateTaskCostUsd({ tier, model, pricing, config, delegation = false }) {
  const price = resolveModelPrice(model, pricing, { overrides: config?.pricing?.overrides });
  if (!price || !Number.isFinite(price.input)) {
    return null;
  }
  return Number(usdFor(taskTokens({ tier, config, delegation }), price, model, config).toFixed(3));
}

/** What the chat itself pays to delegate one task: the Task call and the relay of the reply, at the chat model's rates. */
export function parentOverheadUsd({ model, pricing, config }) {
  const price = model ? resolveModelPrice(model, pricing, { overrides: config?.pricing?.overrides }) : null;
  if (!price || !Number.isFinite(price.input)) {
    return null;
  }
  const tokens = { ...DEFAULT_PARENT_OVERHEAD, ...(config?.budgets?.parentOverhead || {}) };
  return Number(usdFor({ input: asNumber(tokens.input, 0), output: asNumber(tokens.output, 0), cacheRead: asNumber(tokens.cacheRead, 0) }, price, model, config).toFixed(3));
}

/**
 * Is a delegation of this tier's task to `tierModel` worth it next to doing it in the chat on `sessionModel`?
 * Compares whole-task estimates (the delegation's session start included) against the configured minimum
 * savings factor. Returns nulls when a price is unknown.
 */
export function delegationWorth({ tier, tierModel, sessionModel, pricing, config, client = "ide" }) {
  // An Auto chat in the Cursor CLI: its subagents run and are billed as Auto too, so delegating buys nothing and pays
  // a session start on top. Measured on Cursor's bill: the same task cost 13.7¢ direct and 24.9¢ with a Fast subagent (billed as Auto). In the IDE
  // the subagent runs on its own model (billed as Composer): 14.2¢ direct against 9.8¢ routed on the same task.
  if (client === "cli" && /^auto/i.test(String(sessionModel || ""))) {
    return { known: false, worth: null, tierCost: null, chatCost: null, factor: null, sessionUnpriced: true };
  }
  // A chat model with no known price: the parent's own routing choice stands (nothing is denied on a guess).
  const sessionPrice = sessionModel ? resolveModelPrice(sessionModel, pricing, { overrides: config?.pricing?.overrides }) : null;
  if (!sessionPrice || sessionPrice.confidence === "unknown") {
    return { known: false, worth: null, tierCost: null, chatCost: null, factor: null };
  }
  // The delegation's whole cost: the subagent's own session plus what this chat pays to dispatch and relay.
  const subagentCost = tierModel && tierModel !== "inherit" ? estimateTaskCostUsd({ tier, model: tierModel, pricing, config, delegation: true }) : null;
  const overhead = sessionModel ? parentOverheadUsd({ model: sessionModel, pricing, config }) : null;
  const tierCost = subagentCost !== null && overhead !== null ? Number((subagentCost + overhead).toFixed(3)) : null;
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
