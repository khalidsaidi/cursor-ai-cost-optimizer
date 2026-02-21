#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function stripAnsi(input) {
  return String(input).replace(/\x1b\[[0-9;]*m/g, "");
}

function parseArgs(argv) {
  const out = {
    workspace: process.cwd(),
    probe: true
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" && argv[i + 1]) {
      out.workspace = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--no-probe") {
      out.probe = false;
      continue;
    }
  }
  return out;
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
    ...options
  });
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseModelsOutput(stdout) {
  const clean = stripAnsi(stdout);
  const lines = clean.split("\n").map((line) => line.trim()).filter(Boolean);
  const models = [];
  let current = null;
  let defaultModel = null;

  for (const line of lines) {
    const match = line.match(/^([a-z0-9][a-z0-9.-]*)\s+-\s+(.+)$/i);
    if (!match) {
      continue;
    }

    const id = match[1];
    const labelRaw = match[2];
    const flags = labelRaw.toLowerCase();
    const isCurrent = flags.includes("current");
    const isDefault = flags.includes("default");
    const label = labelRaw
      .replace(/\(current\)/gi, "")
      .replace(/\(default\)/gi, "")
      .trim();

    if (isCurrent) {
      current = id;
    }
    if (isDefault) {
      defaultModel = id;
    }

    models.push({
      id,
      label,
      current: isCurrent,
      default: isDefault
    });
  }

  return { models, current, defaultModel };
}

function detectProbeFailure(stderr, stdout) {
  const text = `${stderr || ""}\n${stdout || ""}`;
  if (/hit your usage limit/i.test(text)) {
    return "usage_limit";
  }
  if (/Authentication required/i.test(text)) {
    return "auth_required";
  }
  if (/Workspace Trust Required/i.test(text)) {
    return "workspace_trust";
  }
  return "execution_error";
}

function probeModel(modelId, workspace) {
  const prompt = "Reply exactly: CCO_MODEL_PROBE_OK";
  const res = run(
    "cursor-agent",
    [
      "--model",
      modelId,
      "--trust",
      "-p",
      "--output-format",
      "text",
      "--workspace",
      workspace,
      prompt
    ],
    { timeout: 45_000 }
  );

  const stdout = String(res.stdout || "").trim();
  const stderr = String(res.stderr || "").trim();
  const ok = res.status === 0 && /\bCCO_MODEL_PROBE_OK\b/.test(stdout);
  if (ok) {
    return { runnable: true, reason: "ok", status: res.status };
  }

  return {
    runnable: false,
    reason: detectProbeFailure(stderr, stdout),
    status: res.status,
    stderr: stderr.slice(0, 500),
    stdout: stdout.slice(0, 500)
  };
}

function restoreModel(modelId, workspace) {
  if (!modelId) {
    return { attempted: null, ok: false, reason: "no_initial_model" };
  }
  const prompt = "Reply exactly: CCO_MODEL_RESTORE_OK";
  const res = run(
    "cursor-agent",
    [
      "--model",
      modelId,
      "--trust",
      "-p",
      "--output-format",
      "text",
      "--workspace",
      workspace,
      prompt
    ],
    { timeout: 45_000 }
  );
  const stdout = String(res.stdout || "").trim();
  const stderr = String(res.stderr || "").trim();
  const ok = res.status === 0 && /\bCCO_MODEL_RESTORE_OK\b/.test(stdout);
  return {
    attempted: modelId,
    ok,
    status: res.status,
    reason: ok ? "ok" : detectProbeFailure(stderr, stdout),
    stderr: stderr.slice(0, 300)
  };
}

function chooseProfile(profileName, candidates, availableSet, probeByModel) {
  for (const model of candidates) {
    if (!availableSet.has(model)) {
      continue;
    }
    const probe = probeByModel[model];
    if (!probe || probe.runnable !== false) {
      return {
        profile: profileName,
        model,
        source: "candidate",
        probe
      };
    }
  }
  return {
    profile: profileName,
    model: "auto",
    source: "fallback_auto",
    probe: probeByModel.auto || null
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function collectRunnableModels(candidateIds, probeByModel) {
  const out = [];
  for (const id of candidateIds) {
    const probe = probeByModel[id];
    if (probe && probe.runnable === true) {
      out.push(id);
    }
  }
  return out;
}

function readUserConfig(workspace) {
  const cfgPath = path.join(workspace, ".cursor", "cco.json");
  return readJsonSafe(cfgPath) || {};
}

function normalizeOverrides(config) {
  const raw = config?.modelOverrides;
  const out = { fast: "", balanced: "", deep: "" };
  if (!raw || typeof raw !== "object") {
    return out;
  }
  for (const key of ["fast", "balanced", "deep"]) {
    const v = raw[key];
    out[key] = typeof v === "string" ? v.trim() : "";
  }
  return out;
}

function applyUserOverrides({
  profiles,
  overrides,
  overridePolicy,
  availableSet,
  probeByModel,
  probeEnabled
}) {
  const notes = [];

  for (const profileName of ["fast", "balanced", "deep"]) {
    const requested = overrides[profileName];
    if (!requested) {
      continue;
    }

    if (!availableSet.has(requested)) {
      notes.push(
        `Override ${profileName}=${requested} ignored: model is not in cursor-agent models output.`
      );
      if (overridePolicy === "strict") {
        profiles[profileName] = {
          profile: profileName,
          model: "auto",
          source: "override_strict_fallback_auto",
          probe: probeByModel.auto || null
        };
      }
      continue;
    }

    const probe = probeByModel[requested];
    if (probeEnabled && probe && probe.runnable === false) {
      notes.push(
        `Override ${profileName}=${requested} ignored: model probe failed (${probe.reason}).`
      );
      if (overridePolicy === "strict") {
        profiles[profileName] = {
          profile: profileName,
          model: "auto",
          source: "override_strict_fallback_auto",
          probe: probeByModel.auto || null
        };
      }
      continue;
    }

    profiles[profileName] = {
      profile: profileName,
      model: requested,
      source: "user_override",
      probe: probe || null
    };
  }

  return notes;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = args.workspace;

  const versionRes = run("cursor-agent", ["--version"]);
  const modelsRes = run("cursor-agent", ["models"]);
  if (modelsRes.status !== 0) {
    console.error("Failed to run `cursor-agent models`.");
    process.exit(1);
  }

  const parsed = parseModelsOutput(modelsRes.stdout);
  const availableIds = parsed.models.map((model) => model.id);
  const availableSet = new Set(availableIds);
  const userConfig = readUserConfig(workspace);
  const modelOverrides = normalizeOverrides(userConfig);
  const modelOverridePolicy = userConfig?.modelOverridePolicy === "strict" ? "strict" : "best_effort";

  const cliConfigPath = path.join(os.homedir(), ".cursor", "cli-config.json");
  const initialCliConfig = readJsonSafe(cliConfigPath);
  const initialDisplayModelId = initialCliConfig?.model?.displayModelId ?? null;
  const initialConfiguredModelId = initialCliConfig?.model?.modelId ?? null;

  const profileCandidates = {
    fast: [
      "composer-1.5",
      "composer-1",
      "gpt-5.3-codex-low-fast",
      "gpt-5.2-codex-low-fast",
      "gpt-5.1-codex-mini",
      "auto"
    ],
    balanced: [
      "gpt-5.3-codex-fast",
      "gpt-5.2-codex-fast",
      "sonnet-4.5",
      "gemini-3-pro",
      "composer-1.5",
      "auto"
    ],
    deep: [
      "gpt-5.3-codex-high",
      "gpt-5.3-codex-xhigh",
      "opus-4.6-thinking",
      "sonnet-4.6-thinking",
      "gpt-5.2-high",
      "gemini-3.1-pro",
      "auto"
    ]
  };

  const allCandidates = Array.from(
    new Set(Object.values(profileCandidates).flat().filter((id) => availableSet.has(id)))
  );
  for (const id of Object.values(modelOverrides)) {
    if (id && availableSet.has(id) && !allCandidates.includes(id)) {
      allCandidates.push(id);
    }
  }
  if (availableSet.has("auto") && !allCandidates.includes("auto")) {
    allCandidates.push("auto");
  }

  const probeByModel = {};
  if (args.probe) {
    for (const modelId of allCandidates) {
      probeByModel[modelId] = probeModel(modelId, workspace);
    }
  } else {
    for (const modelId of allCandidates) {
      probeByModel[modelId] = { runnable: null, reason: "probe_disabled" };
    }
  }

  let restore = null;
  if (args.probe) {
    restore = restoreModel(initialDisplayModelId || "auto", workspace);
  }

  const finalCliConfig = readJsonSafe(cliConfigPath);
  const finalDisplayModelId = finalCliConfig?.model?.displayModelId ?? null;
  const finalConfiguredModelId = finalCliConfig?.model?.modelId ?? null;

  const profiles = {
    fast: chooseProfile("fast", profileCandidates.fast, availableSet, probeByModel),
    balanced: chooseProfile("balanced", profileCandidates.balanced, availableSet, probeByModel),
    deep: chooseProfile("deep", profileCandidates.deep, availableSet, probeByModel)
  };
  const overrideNotes = applyUserOverrides({
    profiles,
    overrides: modelOverrides,
    overridePolicy: modelOverridePolicy,
    availableSet,
    probeByModel,
    probeEnabled: args.probe
  });

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workspace,
    cursorAgent: {
      version: String(versionRes.stdout || "").trim(),
      currentModelFromModels: parsed.current,
      defaultModelFromModels: parsed.defaultModel,
      initialDisplayModelFromCliConfig: initialDisplayModelId,
      initialConfiguredModelIdFromCliConfig: initialConfiguredModelId,
      finalDisplayModelFromCliConfig: finalDisplayModelId,
      finalConfiguredModelIdFromCliConfig: finalConfiguredModelId
    },
    discovery: {
      probeEnabled: args.probe,
      availableModels: availableIds,
      runnableModels: args.probe ? collectRunnableModels(allCandidates, probeByModel) : [],
      probes: probeByModel,
      overrides: {
        requested: modelOverrides,
        policy: modelOverridePolicy,
        appliedNotes: overrideNotes
      },
      restore
    },
    profiles
  };

  const distinctProfileModels = new Set(
    Object.values(profiles).map((profile) => profile.model).filter(Boolean)
  );
  const healthNotes = [];
  if (distinctProfileModels.size < 3) {
    healthNotes.push(
      `Only ${distinctProfileModels.size} distinct model(s) are mapped across fast/balanced/deep.`
    );
  }
  if (args.probe) {
    const runnable = output.discovery.runnableModels;
    if (runnable.length < 3) {
      healthNotes.push(
        `Only ${runnable.length} candidate model(s) are runnable in this session; mapping is degraded by availability/usage limits.`
      );
    }
  }
  for (const note of overrideNotes) {
    healthNotes.push(note);
  }

  output.health = {
    degraded: healthNotes.length > 0,
    distinctModelsUsed: distinctProfileModels.size,
    notes: healthNotes
  };

  const outPath = path.join(workspace, ".cursor", "cco-runtime.json");
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  const summary = {
    runtimePath: outPath,
    fast: profiles.fast.model,
    balanced: profiles.balanced.model,
    deep: profiles.deep.model,
    availableCount: availableIds.length,
    degraded: output.health.degraded
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
