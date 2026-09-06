import { useEffect, useState } from "react";
import ChatView from "./components/ChatView";
import { vscode, type ChatState, type ExtensionMessage } from "./types";

const EMPTY: ChatState = { type: "state", running: false, workspace: "", conversationId: null, context: { include: true, file: null, selection: null }, history: [], checkpointsAvailable: false, turns: [], totals: null };

export default function App() {
  const [state, setState] = useState<ChatState>(EMPTY);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    const onMessage = (e: MessageEvent<ExtensionMessage>) => {
      const m = e.data;
      if (m.type === "state") {
        setState(m);
      } else if (m.type === "notice") {
        setNotice(m.text);
      } else if (m.type === "focus") {
        setFocusTick((n) => n + 1);
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const t = setTimeout(() => setNotice(null), 12000);
    return () => clearTimeout(t);
  }, [notice]);

  return <ChatView state={state} notice={notice} focusTick={focusTick} onDismissNotice={() => setNotice(null)} />;
}
