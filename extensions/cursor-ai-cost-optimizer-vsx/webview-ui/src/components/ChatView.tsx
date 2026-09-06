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

  // A new turn scrolls into view; while it streams, Virtuoso's followOutput keeps the bottom only if the reader is
  // already there (scrolling up to read must not be undone by the next delta).
  useEffect(() => {
    if (state.turns.length) {
      listRef.current?.scrollToIndex({ index: state.turns.length - 1, align: "end", behavior: "auto" });
    }
  }, [state.turns.length]);

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
      {state.setup.cli !== "ok" ? (
        <div className="setup-card" role="status">
          {state.setup.cli === "checking" ? (
            <p>Checking the Cursor CLI…</p>
          ) : state.setup.cli === "missing" ? (
            <>
              <p>
                <strong>The Cursor CLI is not installed.</strong> This chat runs every request through it, on your own Cursor account.
              </p>
              <div className="row">
                <button className="button" onClick={() => vscode.postMessage({ type: "setupInstall" })}>Install it in a terminal</button>
                <button className="button secondary" onClick={() => vscode.postMessage({ type: "recheck" })}>I installed it, check again</button>
              </div>
              <p className="muted">If it is installed somewhere unusual, set its path in Settings (costOptimizer.chat.cliPath).</p>
            </>
          ) : (
            <>
              <p>
                <strong>The Cursor CLI is not logged in.</strong> Log in once with your Cursor account; it opens the browser.
              </p>
              <div className="row">
                <button className="button" onClick={() => vscode.postMessage({ type: "setupLogin" })}>Log in</button>
                <button className="button secondary" onClick={() => vscode.postMessage({ type: "recheck" })}>Check again</button>
              </div>
            </>
          )}
        </div>
      ) : null}
      <div className="list">
        {state.turns.length === 0 ? (
          <div className="empty">
            <p>
              <strong>Ask for a change. The cheapest model that can do it well does the work.</strong>
            </p>
            <p>Small changes go to a fast, cheap model. Harder or riskier work goes to a stronger one. Every reply shows which model did it and what it cost.</p>
            <p>It reads and searches this project itself, like Cursor's chat. Attach a file or type @ only to point it somewhere specific.</p>
            <p className="examples">
              Try:
              {["Add input validation to the functions in this file", "Write tests for the add function", "Explain what this project does"].map((ex) => (
                <a key={ex} href="#" className="example" onClick={(e) => { e.preventDefault(); setText(ex); inputRef.current?.focus(); }}>
                  {ex}
                </a>
              ))}
            </p>
            <p className="muted small">
              Runs with the Cursor CLI on your account{state.setup.account ? ` (${state.setup.account})` : ""}, in the {state.workspace || "current"} folder. Changes are written to your files
              {state.checkpointsAvailable ? " and any turn can be undone with its Restore button." : state.checkpointsReason ? `. Undo needs git, which is not available (${state.checkpointsReason}), so use Source Control to revert.` : "."}
              {" "}Shortcut: Ctrl+Alt+C.
            </p>
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
          <span className="muted context-label" title="The model searches and reads this project itself, like Cursor's chat. Attach files only to point it at specific ones.">Attach:</span>
          {state.context.file ? (
            <label className={`context-chip${state.context.include ? "" : " off"}`} title={state.context.include ? "The file you have open (and its selection) goes with your request. Untick to leave it out." : "The open file is left out. Tick to include it."}>
              <input type="checkbox" checked={state.context.include} onChange={(e) => vscode.postMessage({ type: "context", include: e.target.checked })} />
              <span className="context-file">{state.context.file}</span>
              {state.context.selection ? <span className="muted"> lines {state.context.selection}</span> : null}
            </label>
          ) : null}
          {state.context.attached.map((p) => (
            <span key={p} className="context-chip" title={p}>
              <span className="context-file">{p}</span>
              <button className="link" aria-label={`Remove ${p}`} title="Remove" onClick={() => vscode.postMessage({ type: "detach", path: p })}>
                ✕
              </button>
            </span>
          ))}
          <button className="button secondary small" title="Point the request at specific files (or type @ in the box). It reads the rest of the project itself." onClick={() => vscode.postMessage({ type: "pickFile" })}>
            + Add file
          </button>
        </div>
        <TextareaAutosize
          ref={inputRef}
          className="input"
          minRows={2}
          maxRows={10}
          autoFocus
          placeholder="Ask for a change… (@ to attach a file, Enter to send, Shift+Enter for a new line, Esc to stop)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "@") {
              // "@" at the start or after a space opens the file picker, as in Cursor's and Copilot's chat.
              const el = e.currentTarget;
              const before = el.value.slice(0, el.selectionStart ?? 0);
              if (before === "" || /\s$/.test(before)) {
                e.preventDefault();
                vscode.postMessage({ type: "pickFile" });
              }
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
