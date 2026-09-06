import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonSafe, writeJson, readTextSafe, nowIso, ageHours, workspacePaths, hookClient } from "./common.mjs";

/**
 * Per-conversation state. Only parent conversations get a sessionStart hook, so the existence
 * of a session file is how hooks distinguish the parent (router) from subagents.
 */
export function sessionsDir(workspace) {
  return workspacePaths(workspace).sessionsDir;
}

export function sessionPath(workspace, conversationId) {
  const safe = String(conversationId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(sessionsDir(workspace), `${safe || "unknown"}.json`);
}

export function loadSession(workspace, conversationId) {
  if (!workspace || !conversationId) {
    return null;
  }
  return readJsonSafe(sessionPath(workspace, conversationId));
}

export function saveSession(workspace, session) {
  if (!workspace || !session?.conversation_id) {
    return false;
  }
  try {
    writeJson(sessionPath(workspace, session.conversation_id), { ...session, updatedAt: nowIso() });
    return true;
  } catch {
    return false;
  }
}

export function createSession({ workspace, conversationId, model, payload = {} }) {
  const session = {
    conversation_id: conversationId,
    startedAt: nowIso(),
    model: model || null,
    client: hookClient(payload),
    composer_mode: payload.composer_mode ?? null,
    is_background_agent: Boolean(payload.is_background_agent),
    userPrompt: null,
    decision: null,
    delegations: [],
    denials: 0,
    directWork: 0
  };
  saveSession(workspace, session);
  return session;
}

export function updateSession(workspace, conversationId, patch) {
  const existing = loadSession(workspace, conversationId);
  if (!existing) {
    return null;
  }
  const next = { ...existing, ...(typeof patch === "function" ? patch(existing) : patch) };
  saveSession(workspace, next);
  return next;
}

export function pruneSessions(workspace, maxAgeHours = 24 * 7) {
  const dir = sessionsDir(workspace);
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const data = readJsonSafe(full);
    const stamp = data?.updatedAt || data?.startedAt;
    if (!stamp || ageHours(stamp) > maxAgeHours) {
      try {
        fs.unlinkSync(full);
        removed += 1;
      } catch {}
    }
  }
  return removed;
}

/** Extract the first user query from a Cursor agent transcript (JSONL). */
export function userPromptFromTranscript(transcriptPath) {
  const text = transcriptPath ? readTextSafe(transcriptPath) : null;
  if (!text) {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.role !== "user") {
      continue;
    }
    const parts = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const joined = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (!joined) {
      continue;
    }
    const match = joined.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
    return (match ? match[1] : joined.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")).trim();
  }
  return null;
}

/** Cursor stores transcripts under ~/.cursor/projects/<workspace slug>/agent-transcripts/<id>/<id>.jsonl. */
export function guessTranscriptPath(workspace, conversationId) {
  if (!workspace || !conversationId) {
    return null;
  }
  // Cursor slugs the absolute path: strip leading separators (and a Windows drive colon), then non-alphanumerics → "-".
  const slug = String(workspace).replace(/^[\/\\]+/, "").replace(/^([a-zA-Z]):[\/\\]*/, "$1-").replace(/[^a-zA-Z0-9]+/g, "-");
  return path.join(os.homedir(), ".cursor", "projects", slug, "agent-transcripts", String(conversationId), `${conversationId}.jsonl`);
}

/** The IDE reports "default" when the picker is on its default (Auto); treat that as auto for pricing. */
export function normalizeModelId(model) {
  const id = String(model || "").trim();
  if (!id || id === "default" || id === "Auto") {
    return "auto";
  }
  return id;
}

/** Upgrade a session's model from a placeholder (auto/default/empty) to a concrete id seen in a later hook payload. */
export function refineSessionModel(session, candidate) {
  const current = String(session?.model || "");
  const next = String(candidate || "").trim();
  if (!next || next === "default" || next === "auto" || next === "Auto") {
    return false;
  }
  if (!current || current === "auto" || current === "default") {
    session.model = next;
    return true;
  }
  return false;
}

/** Number of user turns in a Cursor transcript (cheap line scan). */
export function countUserTurns(transcriptPath) {
  const text = transcriptPath ? readTextSafe(transcriptPath) : null;
  if (!text) {
    return null;
  }
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith('{"role":"user"') && line.includes("<user_query>")) {
      n += 1;
    }
  }
  return n;
}

/** Reset per-turn gate state when the transcript shows a new user turn (CLI has no per-prompt hook). */
export function syncTurnFromTranscript(session, transcriptPath) {
  const turns = countUserTurns(transcriptPath);
  if (turns === null) {
    return false;
  }
  if ((session.turnFromTranscript || 0) === 0) {
    session.turnFromTranscript = turns;
    return false;
  }
  if (turns > session.turnFromTranscript) {
    session.turnFromTranscript = turns;
    session.delegations = [];
    session.research = [];
    session.denials = 0;
    session.readCount = 0;
    session.readNudged = false;
    session.footerSent = false;
    session.decision = null;
    session.promptMeta = null;
    return true;
  }
  return false;
}

/** The Nth user query in a transcript (negative index from the end). */
export function userPromptFromTranscriptTurn(transcriptPath, index = -1) {
  const text = transcriptPath ? readTextSafe(transcriptPath) : null;
  if (!text) {
    return null;
  }
  const prompts = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"role":"user"')) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const joined = (Array.isArray(entry.message?.content) ? entry.message.content : []).filter((p) => p?.type === "text").map((p) => p.text).join("\n");
    const match = joined.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
    if (match) {
      prompts.push(match[1].trim());
    }
  }
  if (!prompts.length) {
    return null;
  }
  return prompts.at(index) ?? null;
}
