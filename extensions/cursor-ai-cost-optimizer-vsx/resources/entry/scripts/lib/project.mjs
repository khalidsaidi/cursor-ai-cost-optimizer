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
        return { command: `node --test ${dir}/`, kind: "node-test" };
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
export function estimateTaskCostUsd({ tier, model, pricing, config }) {
  const price = resolveModelPrice(model, pricing, { overrides: config?.pricing?.overrides });
  const expected = config?.budgets?.[tier]?.expectedTokens;
  if (!price || !Number.isFinite(price.input) || !expected) {
    return null;
  }
  const input = asNumber(expected.input, 0);
  const output = asNumber(expected.output, 0);
  // Most input is cache reads in a multi-turn subagent session.
  const usd = (input * (0.2 * price.input + 0.8 * price.cacheRead) + output * price.output) / 1_000_000;
  return Number(usd.toFixed(3));
}

export function formatUsd(usd) {
  if (usd === null || usd === undefined) {
    return "";
  }
  return usd < 0.01 ? "<$0.01" : `~$${usd.toFixed(2)}`;
}
