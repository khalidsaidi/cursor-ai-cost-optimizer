/**
 * The chat: a virtualised list of turns above a task header, and the input area below (the same shape as
 * Cline's ChatView: Virtuoso list, autosizing textarea, Enter sends, Shift+Enter breaks the line).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { vscode, type ChatState, type Tier } from "../types";
import ChatRow from "./ChatRow";
import TaskHeader from "./TaskHeader";

interface Props {
  state: ChatState;
  notice: string | null;
  onDismissNotice: () => void;
}

export default function ChatView({ state, notice, onDismissNotice }: Props) {
  const [text, setText] = useState("");
  const [forced, setForced] = useState<Tier | "auto">("auto");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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

  useEffect(() => {
    if (state.turns.length) {
      listRef.current?.scrollToIndex({ index: state.turns.length - 1, align: "end", behavior: "auto" });
    }
  }, [state.turns.length, state.turns[state.turns.length - 1]?.tools.length, state.turns[state.turns.length - 1]?.text]);

  const toggle = useCallback((key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] })), []);

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
            <p>Runs through the Cursor CLI on your own Cursor account, in {state.workspace || "this workspace"}.</p>
          </div>
        ) : (
          <Virtuoso
            ref={listRef}
            data={state.turns}
            followOutput="auto"
            itemContent={(_index, turn) => <ChatRow turn={turn} expanded={expanded} onToggle={toggle} />}
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
        <TextareaAutosize
          ref={inputRef}
          className="input"
          minRows={2}
          maxRows={10}
          placeholder="Ask for a change in this workspace… (Enter to send, Shift+Enter for a new line)"
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
          <span className="grow" />
          <button className="button secondary" onClick={() => vscode.postMessage({ type: "new" })} title="Start a new conversation">
            New
          </button>
          {state.running ? (
            <button className="button secondary" onClick={() => vscode.postMessage({ type: "stop" })}>
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
