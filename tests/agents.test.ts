import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { agents, agentStatus, setAgentEntry, type McpEntry } from '../src/core/agents.ts';

const entry: McpEntry = { command: 'C:\\Apps\\SSH RM\\app.exe', args: ['C:\\Apps\\SSH RM\\server.js', '--data-dir=C:\\D'], env: { ELECTRON_RUN_AS_NODE: '1' } };
const old: McpEntry = { ...entry, command: 'C:\\old\\app.exe' };
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'agents-')), appData = join(home, 'AppData');
  const by = Object.fromEntries(agents(home, appData).map((a) => [a.id, a]));
  const put = (f: string, t: string) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t); };
  return { by, put };
}

test('JSON agents: add, repoint, remove keep every other setting and server', () => {
  const { by, put } = setup();
  const a = by['claude-desktop'];
  assert.equal(agentStatus(a, entry).detected, false);
  put(a.file, JSON.stringify({ mcpServers: { other: { command: 'x' }, 'ssh-resource-manager': old }, preferences: { y: 1 } }));
  assert.equal(agentStatus(a, entry).state, 'other_build');
  setAgentEntry(a, entry);
  let doc = JSON.parse(readFileSync(a.file, 'utf8'));
  assert.deepEqual(doc.mcpServers['ssh-resource-manager'], entry);
  assert.deepEqual(doc.mcpServers.other, { command: 'x' });
  assert.deepEqual(doc.preferences, { y: 1 });
  assert.equal(agentStatus(a, entry).state, 'current');
  assert.ok(existsSync(`${a.file}.sshrm.bak`));
  setAgentEntry(a, null);
  doc = JSON.parse(readFileSync(a.file, 'utf8'));
  assert.deepEqual(Object.keys(doc.mcpServers), ['other']);
  assert.equal(agentStatus(a, entry).state, 'missing');
});

test('missing file and folder are created; VS Code uses "servers" with type stdio', () => {
  const { by } = setup();
  setAgentEntry(by.vscode, entry);
  assert.deepEqual(JSON.parse(readFileSync(by.vscode.file, 'utf8')).servers['ssh-resource-manager'], { type: 'stdio', ...entry });
  assert.equal(agentStatus(by.vscode, entry).state, 'current');
});

test('JSON with comments is refused and left untouched', () => {
  const { by, put } = setup();
  const text = '{\n  // mine\n  "servers": {}\n}';
  put(by.vscode.file, text);
  assert.equal(agentStatus(by.vscode, entry).state, 'unreadable');
  assert.throws(() => setAgentEntry(by.vscode, entry), /not plain JSON/);
  assert.equal(readFileSync(by.vscode.file, 'utf8'), text);
});

test('Codex TOML: our table and its env sub-table are replaced, neighbours stay', () => {
  const { by, put } = setup();
  const c = by.codex;
  put(c.file, ['model = "gpt"', '', '[mcp_servers.ssh-resource-manager]', 'command = "C:\\\\old\\\\app.exe"', 'args = [ "a" ]', '',
    '[mcp_servers.ssh-resource-manager.env]', 'ELECTRON_RUN_AS_NODE = "1"', '', '[mcp_servers.iphone]', 'command = "i.exe"', 'enabled = true', ''].join('\n'));
  assert.equal(agentStatus(c, entry).state, 'other_build');
  setAgentEntry(c, entry);
  const t = readFileSync(c.file, 'utf8');
  assert.equal(agentStatus(c, entry).state, 'current');
  assert.equal(t.match(/\[mcp_servers\.ssh-resource-manager\]/g)?.length, 1);
  assert.match(t, /^model = "gpt"/);
  assert.match(t, /\[mcp_servers\.iphone\]\ncommand = "i\.exe"\nenabled = true/);
  assert.ok(t.includes('command = "C:\\\\Apps\\\\SSH RM\\\\app.exe"'));
  setAgentEntry(c, null);
  assert.ok(!readFileSync(c.file, 'utf8').includes('ssh-resource-manager'));
  assert.ok(readFileSync(c.file, 'utf8').includes('[mcp_servers.iphone]'));
});
