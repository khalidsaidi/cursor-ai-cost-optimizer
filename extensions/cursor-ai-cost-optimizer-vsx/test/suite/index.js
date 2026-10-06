const path = require('path');
const fs = require('fs');
const Mocha = require('mocha');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const loginWaitSeconds = Number.parseInt(process.env.CCO_LOGIN_WAIT_SECONDS || '0', 10);
  const postRunHoldSeconds = Number.parseInt(process.env.CCO_POST_RUN_HOLD_SECONDS || '0', 10);
  if (Number.isFinite(loginWaitSeconds) && loginWaitSeconds > 0) {
    // Optional delay so a user can complete sign-in flows before assertions run.
    console.log(`[CCO] Waiting ${loginWaitSeconds}s before running tests (CCO_LOGIN_WAIT_SECONDS).`);
    await sleep(loginWaitSeconds * 1000);
  }

  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 60_000,
  });

  const testsRoot = __dirname;

  return new Promise((resolve, reject) => {
    fs.readdirSync(testsRoot)
      .filter((file) => file.endsWith('.test.js'))
      .forEach((file) => mocha.addFile(path.resolve(testsRoot, file)));

    mocha.run(async (failures) => {
      if (Number.isFinite(postRunHoldSeconds) && postRunHoldSeconds > 0) {
        console.log(`[CCO] Holding window open for ${postRunHoldSeconds}s after test run (CCO_POST_RUN_HOLD_SECONDS).`);
        await sleep(postRunHoldSeconds * 1000);
      }

      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`));
      } else {
        resolve();
      }
    });
  });
}

module.exports = { run };
