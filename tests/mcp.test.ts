import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCore } from '../src/core/index.ts';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..', process.env.MCP_ENTRY ?? 'src/mcp/server.ts');

test('stdout carries only JSON-RPC: raw initialize gets one clean JSON line', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sshrm-mcp-'));
  const child = spawn(process.execPath, [server, `--data-dir=${dataDir}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 1500));
  child.kill();
  const lines = out.split('\n').filter(Boolean);
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0', `non-protocol stdout: ${l}`);
});

test('ssh still runs when the MCP client gives the server a minimal env (no ProgramData)', async () => {
  const { childEnv, run } = await import('../src/core/ssh.ts');
  const saved = process.env.ProgramData;
  delete process.env.ProgramData;
  try {
    assert.ok(childEnv().ProgramData);
    const r = await run(['ssh'], ['-V'], { timeoutMs: 10_000 });
    assert.equal(r.exit_code, 0, r.stderr);
  } finally { process.env.ProgramData = saved; }
});

test('real MCP client: list tools, register from chat, GUI core sees it immediately', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sshrm-mcp-'));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, `--data-dir=${dataDir}`], stderr: 'ignore' }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['ssh_hosts_register', 'ssh_hosts_check', 'ssh_hosts_get_connection_recipe', 'ssh_projects_preflight', 'ssh_projects_verify_sync']) assert.ok(tools.includes(n), n);

  const parsed = await client.callTool({ name: 'ssh_hosts_parse_connection_input', arguments: { text: 'ssh dev@192.168.1.50 -p 2222', source_shell: 'powershell' } });
  const draft = (parsed.structuredContent as { draft: Record<string, unknown> }).draft;
  const reg = await client.callTool({ name: 'ssh_hosts_register', arguments: { profile: draft, metadata: { name: 'Office Mac', declared_os: 'macos', description: 'has Xcode' }, idempotency_key: 'chat-reg-0001' } });
  assert.ok(!reg.isError, JSON.stringify(reg.content));
  const id = (reg.structuredContent as { host: { id: string } }).host.id;

  const gui = createCore({ dataDir, source: 'gui' });
  assert.equal(gui.getHost({ host_id: id }).name, 'Office Mac');

  const bad = await client.callTool({ name: 'ssh_hosts_update', arguments: { host_id: id, expected_revision: 99, patch: {}, idempotency_key: 'chat-upd-0001' } });
  assert.equal(bad.isError, true);
  assert.equal((bad.structuredContent as { error: { code: string } }).error.code, 'REVISION_CONFLICT');

  const rejected = await client.callTool({ name: 'ssh_hosts_parse_connection_input', arguments: { text: 'ssh dev@h "$(calc)"', source_shell: 'posix' } });
  assert.equal((rejected.structuredContent as { ok: boolean }).ok, false);
  await client.close();
});
