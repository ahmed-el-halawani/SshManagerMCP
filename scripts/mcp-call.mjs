// Calls one tool on this checkout's MCP server and prints exactly the text an MCP client receives.
// For trying the current code from a shell (e.g. with a test agent) without reinstalling the app.
// usage: node scripts/mcp-call.mjs <tool> ['<json args>']      node scripts/mcp-call.mjs --list
// SSHRM_CALL_LOG=<file> appends one JSON line per call (tool, ms, chars, error) for scoring a run.
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [tool, json] = process.argv.slice(2);
const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.ts');
const client = new Client({ name: 'mcp-call', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, SSHRM_NO_GUI: '1' }, stderr: 'ignore' }));
if (!tool || tool === '--list') {
  for (const t of (await client.listTools()).tools) console.log(`${t.name}: ${t.description}\n  args: ${JSON.stringify(t.inputSchema.properties)}\n`);
} else {
  const t = Date.now();
  const r = await client.callTool({ name: tool, arguments: json ? JSON.parse(json) : {} }, undefined, { timeout: 300_000 });
  const text = r.content.map((c) => c.text ?? '').join('');
  if (process.env.SSHRM_CALL_LOG) appendFileSync(process.env.SSHRM_CALL_LOG, JSON.stringify({ tool, ms: Date.now() - t, chars: text.length, error: !!r.isError }) + '\n');
  console.log(text);
  process.exitCode = r.isError ? 1 : 0;
}
await client.close();
