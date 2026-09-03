const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

async function main() {
  try {
    const downloadedExecutablePath = await downloadAndUnzipVSCode(process.env.CCO_VSCODE_VERSION || undefined);
    // Launch the Electron binary directly. The `bin/code` shell wrapper (used previously for WSL)
    // exits 0 without starting the extension host on recent VS Code builds, which makes the run
    // look green while executing zero tests. Set CCO_VSCODE_USE_CLI=1 to opt back into the wrapper.
    const wslCliCandidate = path.resolve(path.dirname(downloadedExecutablePath), 'bin', 'code');
    const vscodeExecutablePath =
      process.env.CCO_VSCODE_USE_CLI === '1' && fs.existsSync(wslCliCandidate)
        ? wslCliCandidate
        : downloadedExecutablePath;

    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    const extensionTestsPath = path.resolve(__dirname, './suite/index.js');
    const workspacePath = path.resolve(__dirname, '../test-fixtures/workspace');
    // Fake Cursor CLI so discovery is deterministic and offline; the extension only writes under the fixture's .cursor/.

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath, '--disable-extensions'],
      extensionTestsEnv: {
        DONT_PROMPT_WSL_INSTALL: '1',
        VSCODE_IPC_HOOK_CLI: '',
        CCO_CURSOR_AGENT_BIN: require('./fixtures/fake-agent-path.js'),
      },
    });
  } catch (error) {
    console.error('Failed to run integration tests');
    console.error(error);
    process.exit(1);
  }
}

main();
