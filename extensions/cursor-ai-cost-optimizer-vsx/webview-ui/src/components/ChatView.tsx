/**
 * The chat: a virtualised list of turns under a task header, and the input area below (the same shape as
 * Cline's ChatView: Virtuoso list, autosizing textarea, Enter sends, Shift+Enter breaks the line, Escape stops).
 * Above the input: the context chip (the active file and selection that travel with the request, switchable)
 * and a history menu of this workspace's earlier conversations.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { formatUsd, vscode, type ChatState, type Tier } from "../types";
import ChatRow from "./ChatRow";
import TaskHeader from "./TaskHeader";

interface Props {
  state: ChatState;
  notice: string | null;
  focusTick: number;
  onDismissNotice: () => void;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.round(ms / 60000);
  if (m < 1) {
    return "just now";
  }
  if (m < 60) {
    return `${m} min ago`;
  }
  const h = Math.round(m / 60);
  if (h < 24) {
    return `${h} h ago`;
  }
  return `${Math.round(h / 24)} d ago`;
}

export default function ChatView({ state, notice, focusTick, onDismissNotice }: Props) {
  const [text, setText] = useState("");
  const [forced, setForced] = useState<Tier | "auto">("auto");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showHistory, setShowHistory] = useState(false);
  const listRef = useRef<VirtuosoHandle>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = useCallback(() => {
    const value = text.trim();
    if (!value || state.running) {
      return;
    }
    vscode.postMessage({ type: "send", text: value, forced });
    setText("");
  }, [text, forced, state.running]);

  const last = state.turns[state.turns.length - 1];
  useEffect(() => {
    if (state.turns.length) {
      listRef.current?.scrollToIndex({ index: state.turns.length - 1, align: "end", behavior: "auto" });
    }
  }, [state.turns.length, last?.tools.length, last?.text, last?.status]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusTick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state.running) {
        vscode.postMessage({ type: "stop" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.running]);

  const toggle = useCallback((key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] })), []);
  const others = state.history.filter((h) => h.id !== state.conversationId);

  return (
    <div className="chat">
      {state.turns.length ? <TaskHeader state={state} /> : null}
      <div className="list">
        {state.turns.length === 0 ? (
          <div className="empty">
            <p>
              <strong>Every reply here names the model that produced it.</strong>
            </p>
            <p>Routine work goes to the Fast tier's model, medium work to Balanced, risky or complex work to Deep. Pick a tier below to force one.</p>
            <p>Runs through the Cursor CLI on your own Cursor account, in {state.workspace || "this workspace"}. Edits land in your files; each turn can be undone from its checkpoint.</p>
            {others.length ? (
              <p>
                <a href="#" onClick={(e) => { e.preventDefault(); setShowHistory(true); }}>
                  {others.length === 1 ? "1 earlier conversation" : `${others.length} earlier conversations`}
                </a>
              </p>
            ) : null}
          </div>
        ) : (
          <Virtuoso
            ref={listRef}
            data={state.turns}
            followOutput="auto"
            itemContent={(_index, turn) => <ChatRow turn={turn} expanded={expanded} onToggle={toggle} checkpointsAvailable={state.checkpointsAvailable} />}
            components={{ Footer: () => <div style={{ height: 8 }} /> }}
          />
        )}
      </div>
      <div className="input-area">
        {notice ? (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button className="link" onClick={onDismissNotice} aria-label="Dismiss">
              ✕
            </button>
          </div>
        ) : null}
        {showHistory ? (
          <div className="history" role="menu">
            <div className="row">
              <strong>Earlier conversations</strong>
              <span className="grow" />
              <button className="link" onClick={() => setShowHistory(false)} aria-label="Close">
                ✕
              </button>
            </div>
            {others.length === 0 ? <div className="muted">None yet in this workspace.</div> : null}
            {others.map((h) => (
              <div key={h.id} className="history-row">
                <a
                  href="#"
                  className="history-title"
                  title={h.title}
                  onClick={(e) => {
                    e.preventDefault();
                    setShowHistory(false);
                    vscode.postMessage({ type: "history", id: h.id });
                  }}
                >
                  {h.title}
                </a>
                <span className="muted">
                  {h.turns} {h.turns === 1 ? "turn" : "turns"} · {formatUsd(h.usd) || "$0"} · {timeAgo(h.updatedAt)}
                </span>
                <button className="link" title="Delete this conversation" onClick={() => vscode.postMessage({ type: "historyDelete", id: h.id })} aria-label="Delete">
                  🗑
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="row context-row">
          {state.context.file ? (
            <label className={`context-chip${state.context.include ? "" : " off"}`} title={state.context.include ? "The active file (and selection) is sent with your request. Click to leave it out." : "The active file is not sent. Click to include it."}>
              <input type="checkbox" checked={state.context.include} onChange={(e) => vscode.postMessage({ type: "context", include: e.target.checked })} />
              <span className="context-file">{state.context.file}</span>
              {state.context.selection ? <span className="muted"> lines {state.context.selection}</span> : null}
            </label>
          ) : (
            <span className="muted context-none">No file open: the request goes without file context.</span>
          )}
        </div>
        <TextareaAutosize
          ref={inputRef}
          className="input"
          minRows={2}
          maxRows={10}
          autoFocus
          placeholder="Ask for a change in this workspace… (Enter to send, Shift+Enter for a new line, Esc to stop)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="row">
          <select className="select" value={forced} onChange={(e) => setForced(e.target.value as Tier | "auto")} title="Which tier runs this request">
            <option value="auto">Route automatically</option>
            <option value="fast">Fast tier</option>
            <option value="balanced">Balanced tier</option>
            <option value="deep">Deep tier</option>
          </select>
          <button className="button secondary" onClick={() => setShowHistory((v) => !v)} title="Earlier conversations in this workspace">
            History{others.length ? ` (${others.length})` : ""}
          </button>
          <span className="grow" />
          <button className="button secondary" onClick={() => vscode.postMessage({ type: "new" })} title="Start a new conversation">
            New
          </button>
          {state.running ? (
            <button className="button secondary" onClick={() => vscode.postMessage({ type: "stop" })} title="Stop (Esc)">
              Stop
            </button>
          ) : null}
          <button className="button" onClick={send} disabled={state.running || !text.trim()}>
            Send
          </button>
        </div>
        <div className="row links">
          <a href="#" onClick={(e) => { e.preventDefault(); vscode.postMessage({ type: "models" }); }}>
            Tier models
          </a>
          <span>·</span>
          <a href="#" onClick={(e) => { e.preventDefault(); vscode.postMessage({ type: "settings" }); }}>
            Settings
          </a>
        </div>
      </div>
    </div>
  );
}
