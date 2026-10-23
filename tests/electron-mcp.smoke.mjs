// Smoke: the built MCP server runs under the Electron runtime (as the installer configures it)
// and shares the DB with a GUI-side core. Usage: node tests/electron-mcp.smoke.mjs [path-to-electron-or-app-exe] [path-to-server.js]
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exe = process.argv[2] ?? resolve('node_modules/electron/dist/electron.exe');
const entry = process.argv[3] ?? resolve('dist/mcp/server.js');
const dataDir = mkdtempSync(join(tmpdir(), 'sshrm-smoke-'));
const client = new Client({ name: 'smoke', version: '1' });
await client.connect(new StdioClientTransport({ command: exe, args: [entry, `--data-dir=${dataDir}`], env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot } }));
const env = await client.callTool({ name: 'ssh_manager_environment', arguments: {} });
assert.equal(env.structuredContent.data_dir, dataDir);
const reg = await client.callTool({ name: 'ssh_hosts_register', arguments: { profile: { mode: 'ssh_alias', alias: 'smoke' }, metadata: { name: 'smoke' }, idempotency_key: 'smoke-0001' } });
assert.ok(!reg.isError, JSON.stringify(reg.content));
await client.close();

// Read the same DB with plain Node (the GUI side uses the same core code).
const { createCore } = await import('../dist/core/index.js');
const gui = createCore({ dataDir, source: 'gui' });
assert.equal(gui.listHosts().hosts[0].name, 'smoke');
console.log(`OK: ${exe} ran MCP; same DB readable (${dataDir})`);
