# Security policy

Report vulnerabilities privately to khalidsaidi66@gmail.com. Do not open a public issue for security problems. You will get an acknowledgement within 72 hours.

What this project does on your machine: the plugin's hooks run `node` (or the extension's bundled binary) in response to Cursor hook events and read/write only inside the project's `.cursor/` folder; model discovery makes a few tiny requests through your own Cursor account; no data is sent anywhere else. Logs contain routing scores and tool names, never prompt text.
