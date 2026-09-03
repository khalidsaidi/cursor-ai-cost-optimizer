"use strict";

/** Returns a greeting for `name` (fixture code for extension tests). */
function hello(name) {
  return `Hello, ${String(name || "world").trim()}!`;
}

module.exports = { hello };
