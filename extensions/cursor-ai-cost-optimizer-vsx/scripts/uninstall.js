#!/usr/bin/env node
// `vscode:uninstall` hook: runs (plain Node, no vscode API) after the extension is uninstalled and the
// editor restarts. It removes the extension's global storage folder in every known Cursor / VS Code user-data
// location. Workspace files (.cursor/...) are deliberately left alone — they belong to the project and are
// removed with the "AI Cost Optimizer: Uninstall from This Workspace" command (or the plugin's cco-init --uninstall).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXTENSION_ID = "khalidsaidi.cursor-ai-cost-optimizer";

function userDataRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    roots.push(path.join(appData, "Cursor", "User"), path.join(appData, "Code", "User"), path.join(appData, "Code - Insiders", "User"));
  } else if (process.platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    roots.push(path.join(support, "Cursor", "User"), path.join(support, "Code", "User"), path.join(support, "Code - Insiders", "User"));
  } else {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    roots.push(path.join(config, "Cursor", "User"), path.join(config, "Code", "User"), path.join(config, "Code - Insiders", "User"));
    // remote (SSH/WSL) servers keep user data under the server dir
    roots.push(path.join(home, ".cursor-server", "data", "User"), path.join(home, ".vscode-server", "data", "User"));
  }
  return roots;
}

let removed = 0;
for (const root of userDataRoots()) {
  const dir = path.join(root, "globalStorage", EXTENSION_ID);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[cco uninstall] removed ${dir}`);
      removed += 1;
    }
  } catch (error) {
    console.log(`[cco uninstall] could not remove ${dir}: ${error && error.message ? error.message : error}`);
  }
}
console.log(`[cco uninstall] done (${removed} global storage folder(s) removed). Workspace files under .cursor/ were left in place; run "AI Cost Optimizer: Uninstall from This Workspace" before removing the extension to clean them.`);
