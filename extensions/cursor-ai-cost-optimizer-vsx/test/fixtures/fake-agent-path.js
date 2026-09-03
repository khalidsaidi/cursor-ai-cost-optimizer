const path = require("path");
module.exports = path.join(__dirname, process.platform === "win32" ? "fake-cursor-agent.cmd" : "fake-cursor-agent.sh");
