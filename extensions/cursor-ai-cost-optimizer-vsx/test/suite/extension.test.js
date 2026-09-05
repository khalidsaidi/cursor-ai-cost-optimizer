const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

// runTest.js points CCO_CURSOR_AGENT_BIN at a fake CLI; everything the extension writes is under the fixture's .cursor/.
const COMMANDS = ['cco.installCursorAssets', 'cco.chooseTierModels', 'cco.uninstallCursorAssets', 'cco.togglePause', 'cco.showMenu', 'cco.recommendTier', 'cco.insertOverrideFast', 'cco.insertOverrideBalanced', 'cco.insertOverrideDeep', 'cco.showOutputChannel', 'cco.collectDiagnostics'];
const CCO_RE = /cco-hook|\.cursor[\\/]cco[\\/]scripts[\\/]cco-/;
const BINARY_FORM = /^"[^"]+[\\/]\.cursor[\\/]cco[\\/]bin[\\/]cco-hook(\.exe)?" \w+$/;
const NODE_FORM = /^node \.cursor\/cco-hook\.mjs [A-Za-z]+$/;
const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

const proof = {
  generatedAt: '',
  extensionId: 'khalidsaidi.cursor-ai-cost-optimizer',
  commandPresence: {},
  installChecks: { files: {}, topLevelEntries: [], hooks: { mode: '', events: [], foreignEntryPreserved: false, ccoEntriesValid: false }, agents: {}, pluginPath: '' },
  uninstallChecks: { ccoDirRemoved: false, ruleRemoved: false, foreignHookPreserved: false, ccoHooksRemoved: false, agentsRemoved: false, configRemoved: false },
  insertChecks: { expected: '[cco:fast][cco:balanced][cco:deep]', actual: '', matched: false },
};

describe('AI Cost Optimizer extension', () => {
  after(() => {
    const root = workspaceRoot();
    if (!root) return;
    proof.generatedAt = new Date().toISOString();
    const outDir = path.join(root, '.ai', 'cco');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'test-proof.json'), `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  });

  it('mirrors the Settings UI into the plugin config the hooks read', async () => {
    const extension = vscode.extensions.getExtension('khalidsaidi.cursor-ai-cost-optimizer');
    const api = await extension.activate();
    assert.ok(api && api.stateRoot, 'activate() exposes the state root');
    const file = path.join(api.stateRoot, 'cco.json');
    assert.ok(fs.existsSync(file), 'settings are mirrored at activation');
    const cfg = vscode.workspace.getConfiguration('cco');
    await cfg.update('chatBudgetUsd', 3, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 1500));
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.budget.sessionUsd, 3, 'a changed setting reaches the config file');
    assert.equal(written.enforcement.mode, 'advise');
    await cfg.update('chatBudgetUsd', undefined, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).budget.sessionUsd, 0, 'reset reaches the file too');
    proof.settingsSync = true;
  });

  it('registers all commands', async () => {
    const extension = vscode.extensions.getExtension('khalidsaidi.cursor-ai-cost-optimizer');
    assert.ok(extension, 'Expected extension to be discoverable');
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of COMMANDS) {
      proof.commandPresence[id] = commands.includes(id);
      assert.ok(proof.commandPresence[id], `Expected command to be registered: ${id}`);
    }
  });

  it('install writes only under .cursor/ (plugin layout + rule + hooks), preserving foreign hook entries', async () => {
    const root = workspaceRoot();
    assert.ok(root, 'Expected a workspace folder');
    fs.rmSync(path.join(root, '.cursor'), { recursive: true, force: true });
    fs.rmSync(path.join(root, '.ai'), { recursive: true, force: true });
    fs.rmSync(path.join(root, '.gitignore'), { force: true });
    fs.mkdirSync(path.join(root, '.cursor'));
    const hooksPath = path.join(root, '.cursor', 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: 'other-tool-hook' }] } }, null, 2));
    const before = fs.readdirSync(root).sort();

    await vscode.commands.executeCommand('cco.installCursorAssets', { confirm: false, scope: 'project' });

    const files = ['.cursor/hooks.json', '.cursor/cco-hook.mjs', '.cursor/cco/plugin-path.txt', '.cursor/cco/runtime.json', '.cursor/cco/extension-manifest.json', '.cursor/agents/fast-tier.md', '.cursor/agents/balanced-tier.md', '.cursor/agents/deep-tier.md', '.cursor/agents/tier-verifier.md', '.cursor/agents/fast-research.md', '.cursor/rules/cco-routing.mdc'];
    for (const rel of files) {
      proof.installChecks.files[rel] = fs.existsSync(path.join(root, ...rel.split('/')));
      assert.ok(proof.installChecks.files[rel], `Expected ${rel}`);
    }
    proof.installChecks.topLevelEntries = fs.readdirSync(root).sort();
    assert.deepStrictEqual(proof.installChecks.topLevelEntries, before, 'no new top-level files in the repo (no .ai, no .gitignore edits)');
    proof.installChecks.pluginPath = fs.readFileSync(path.join(root, '.cursor', 'cco', 'plugin-path.txt'), 'utf8').trim();
    assert.ok(proof.installChecks.pluginPath.endsWith(path.join('resources', 'plugin')), `plugin-path.txt points at the bundled plugin: ${proof.installChecks.pluginPath}`);
    for (const name of ['fast-tier', 'balanced-tier', 'deep-tier', 'tier-verifier']) {
      const text = fs.readFileSync(path.join(root, '.cursor', 'agents', `${name}.md`), 'utf8');
      proof.installChecks.agents[name] = (text.match(/^model:\s*(.+)$/m) || [])[1] || null;
      assert.ok(text.includes('generated by cursor-ai-cost-optimizer'), `${name} carries the generated marker`);
    }
    assert.strictEqual(proof.installChecks.agents['fast-tier'], 'composer-2.5', 'tier model from (fake) discovery');

    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'cco', 'extension-manifest.json'), 'utf8'));
    proof.installChecks.hooks.mode = manifest.hookMode;
    proof.installChecks.hooks.events = Object.keys(hooks.hooks);
    proof.installChecks.hooks.foreignEntryPreserved = hooks.hooks.afterFileEdit?.[0]?.command === 'other-tool-hook';
    assert.ok(proof.installChecks.hooks.foreignEntryPreserved, 'foreign hook entry preserved');
    const ours = Object.values(hooks.hooks).flat().filter((e) => CCO_RE.test(e.command));
    const form = manifest.hookMode === 'binary' ? BINARY_FORM : NODE_FORM;
    proof.installChecks.hooks.ccoEntriesValid = ours.length >= 8 && ours.every((e) => form.test(e.command));
    assert.ok(proof.installChecks.hooks.ccoEntriesValid, `CCO hook commands use the ${manifest.hookMode} form: ${ours.map((e) => e.command).join(' | ')}`);
    if (manifest.hookMode === 'binary') {
      assert.ok(fs.existsSync(path.join(root, '.cursor', 'cco', 'bin')), 'binary copied into .cursor/cco/bin');
    }
    for (const event of ['sessionStart', 'workspaceOpen', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'subagentStop', 'beforeShellExecution', 'sessionEnd']) {
      assert.ok(Array.isArray(hooks.hooks[event]) && hooks.hooks[event].length > 0, `hook event present: ${event}`);
    }
    const gate = hooks.hooks.preToolUse.find((e) => CCO_RE.test(e.command));
    const template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'plugin', 'hooks', 'hooks.json'), 'utf8'));
    const expected = template.hooks.preToolUse[0];
    assert.ok(gate && gate.matcher === expected.matcher && gate.timeout === expected.timeout, 'matcher/timeout preserved');
  });

  it('uninstall removes CCO pieces but keeps others', async () => {
    const root = workspaceRoot();
    const hooksPath = path.join(root, '.cursor', 'hooks.json');
    await vscode.commands.executeCommand('cco.uninstallCursorAssets', { confirm: false });
    proof.uninstallChecks.ccoDirRemoved = !fs.existsSync(path.join(root, '.cursor', 'cco'));
    proof.uninstallChecks.ruleRemoved = !fs.existsSync(path.join(root, '.cursor', 'rules', 'cco-routing.mdc'));
    proof.uninstallChecks.agentsRemoved = !fs.existsSync(path.join(root, '.cursor', 'agents', 'fast-tier.md'));
    proof.uninstallChecks.configRemoved = !fs.existsSync(path.join(root, '.cursor', 'cco.json'));
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    proof.uninstallChecks.foreignHookPreserved = hooks.hooks.afterFileEdit?.[0]?.command === 'other-tool-hook';
    proof.uninstallChecks.ccoHooksRemoved = !Object.values(hooks.hooks).flat().some((e) => CCO_RE.test(e.command));
    for (const [k, v] of Object.entries(proof.uninstallChecks)) assert.ok(v, k);
    // leave an installed state (without the foreign test hook) for the proof scripts
    fs.rmSync(hooksPath, { force: true });
    await vscode.commands.executeCommand('cco.installCursorAssets', { confirm: false, scope: 'project' });
    assert.ok(fs.existsSync(path.join(root, '.cursor', 'agents', 'fast-tier.md')));
  });

  it('insert override commands insert expected tokens', async () => {
    const root = workspaceRoot();
    const filePath = path.join(root, 'tokens.md');
    fs.writeFileSync(filePath, '', 'utf8');
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    await vscode.commands.executeCommand('cco.insertOverrideFast');
    await vscode.commands.executeCommand('cco.insertOverrideBalanced');
    await vscode.commands.executeCommand('cco.insertOverrideDeep');
    const content = editor.document.getText();
    proof.insertChecks.actual = content;
    proof.insertChecks.matched = content === proof.insertChecks.expected;
    assert.strictEqual(content, proof.insertChecks.expected);
  });
});
