// Deterministic stand-in for the Cursor CLI used by tests (CCO_CURSOR_AGENT_BIN -> .sh on POSIX, .cmd on Windows).
const arg = process.argv[2] || "";
if (arg === "--version") {
  console.log("test-cli-0.0.0");
} else if (arg === "models") {
  console.log(["composer-2.5 - Composer 2.5 (current, default)", "claude-sonnet-5-thinking-high - Claude Sonnet 5 Thinking High", "claude-opus-5-thinking-high - Claude Opus 5 Thinking High", "gemini-3.8-flash - Gemini 3.8 Flash"].join("\n"));
} else if (arg === "status") {
  console.log("Logged in as test@example.com");
} else {
  console.log('{"type":"result","result":"ok"}');
}
