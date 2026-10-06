import { delegationWorth } from "./project.mjs";
import { TIERS, readJsonSafe, workspacePaths, agentForTier } from "./common.mjs";
import { loadPricing, resolveModelPrice, blendedRatePerMillion } from "./pricing.mjs";
import { readWorkspaceAgentModel } from "./agents.mjs";

function fmtPrice(price) {
  if (!price || !Number.isFinite(price.input)) {
    return "price n/a";
  }
  return `$${price.input}/M in, $${price.output}/M out`;
}

/**
 * Build the short context block injected at sessionStart so the parent agent knows
 * the live tier→model mapping and relative prices without reading files.
 */
export function buildSessionContext({ workspace, config, sessionModel, client = "ide" }) {
  const paths = workspacePaths(workspace);
  const runtime = readJsonSafe(paths.runtimePath);
  const pricing = loadPricing(paths.pricingPath);
  const lines = ["CCO (AI Cost Optimizer) is active. Tier subagents in this workspace (use these exact names as subagent_type):"];
  const tierPrices = {};
  for (const tier of TIERS) {
    const fromAgent = readWorkspaceAgentModel(workspace, agentForTier(tier, workspace));
    const model = fromAgent || runtime?.profiles?.[tier]?.model || "inherit";
    const price = model === "inherit" ? null : resolveModelPrice(model, pricing, { overrides: config?.pricing?.overrides });
    tierPrices[tier] = { model, price };
    lines.push(`- ${tier.toUpperCase()} tier → subagent \`${agentForTier(tier, workspace)}\` on ${model}${model === "inherit" ? " (not set up in this workspace; run cco-init --workspace . once)" : ` (${fmtPrice(price)})`}`);
  }
  const verifierModel = readWorkspaceAgentModel(workspace, "tier-verifier") || runtime?.verifier?.model || "inherit";
  const exploreModel = readWorkspaceAgentModel(workspace, "fast-research") || tierPrices.fast.model;
  lines.push(`- tier-verifier → ${verifierModel}; fast-research (read-only research) → ${exploreModel}`);

  if (sessionModel) {
    const sessionPrice = resolveModelPrice(sessionModel, pricing, { overrides: config?.pricing?.overrides });
    const sessionBlended = blendedRatePerMillion(sessionPrice);
    const fastBlended = blendedRatePerMillion(tierPrices.fast.price);
    let ratio = "";
    const worth = delegationWorth({ tier: "fast", tierModel: tierPrices.fast.model, sessionModel, pricing, config, client });
    if (worth.known) {
      const factor = worth.factor;
      if (worth.worth) {
        ratio = ` A typical FAST task costs about $${worth.tierCost.toFixed(2)} delegated (the subagent's session and this chat's dispatch included) against about $${worth.chatCost.toFixed(2)} done here: delegate FAST work.`;
      } else if (factor <= 0.67 && !config?.modelOverrides?.fast) {
        // Only when the Fast model was picked automatically: a model the user chose for the tier is used as chosen.
        ratio = ` This session model is already cheaper than the FAST tier; answer simple requests directly.`;
      } else if (factor <= 0.67) {
        ratio = ` The FAST tier's model was chosen by the user: delegate FAST work to it as usual.`;
      }
    }
    if (worth.sessionUnpriced) {
      lines.push(`Session model: Auto in the Cursor CLI, where a subagent also runs on Auto and pays its own session start (measured: delegating cost more). Routine work stays in this chat. Delegate only risky work to the DEEP subagent, or a tier the user forces with [cco:…].`);
    } else {
      lines.push(`Session model: ${sessionModel} (${fmtPrice(sessionPrice)}).${ratio}`);
    }
    const minSavings = Number(config?.enforcement?.minSavingsFactor ?? 1.3);
    const routerMode = config?.enforcement?.requireDelegation === "always" || (sessionBlended && fastBlended && sessionBlended / fastBlended >= minSavings && config?.enforcement?.requireDelegation !== "never");
    if (routerMode) {
      const worth = TIERS.filter((tier) => {
        const rate = blendedRatePerMillion(tierPrices[tier].price);
        return rate && sessionBlended / rate >= minSavings;
      });
      const keep = TIERS.filter((tier) => !worth.includes(tier));
      lines.push(`ROUTER MODE is on for this chat: for any request that needs tools and scores ${worth.map((t) => t.toUpperCase()).join("/") || "(none)"}, your FIRST action is one Task call to that tier's subagent named above (no reading or editing here), and after it returns you relay the result in at most 5 short lines with no further tool calls. Exception: a simple question (explain/what/why) is answered directly with at most a couple of reads.${keep.length ? ` ${keep.map((t) => t.toUpperCase()).join("/")} work stays in this chat (its model is not cheaper than yours).` : ""} Hooks enforce this.`);
    }
  }

  const tokens = config?.overrideTokens || {};
  lines.push(
    `Overrides: ${tokens.fast || "[cco:fast]"} ${tokens.balanced || "[cco:balanced]"} ${tokens.deep || "[cco:deep]"} ${tokens.auto || "[cco:auto]"}. Delegated Task prompts must start with a CCO-SCORES line; a hook enforces risk guardrails and logs decisions under .cursor/cco/state.`
  );
  if (runtime?.health?.degraded && Array.isArray(runtime.health.notes) && runtime.health.notes.length) {
    lines.push(`Status: degraded — ${runtime.health.notes.slice(0, 3).join("; ")}`);
  }
  return lines.join("\n");
}
