// Calls this repo's built MCP server (dist/mcp/server.js under Electron) from a shell: for benchmarks and debugging
// with an agent whose own MCP connection runs another build.
//   node scripts/mcp-call.mjs tools                 -> server instructions + every tool's name, description, input schema
//   node scripts/mcp-call.mjs <tool> '<json args>'  -> the tool's JSON result (exit 1 when the tool reports an error)
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [name, json = '{}'] = process.argv.slice(2);
if (!name) { console.error("usage: node scripts/mcp-call.mjs tools | <tool> '<json args>'"); process.exit(2); }
const client = new Client({ name: 'mcp-call', version: '1' });
await client.connect(new StdioClientTransport({
  command: resolve(root, 'node_modules/electron/dist/electron.exe'),
  args: [resolve(root, 'dist/mcp/server.js'), ...(process.env.SSHRM_DATA_DIR ? [`--data-dir=${process.env.SSHRM_DATA_DIR}`] : [])],
  env: { ELECTRON_RUN_AS_NODE: '1', SSHRM_NO_GUI: '1', SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP },
}));
let code = 0;
if (name === 'tools') {
  console.log(`SERVER INSTRUCTIONS: ${client.getInstructions()}\n`);
  for (const t of (await client.listTools()).tools) console.log(`## ${t.name}\n${t.description}\ninput: ${JSON.stringify(t.inputSchema.properties)} required: ${JSON.stringify(t.inputSchema.required ?? [])}\n`);
} else {
  const r = await client.callTool({ name, arguments: JSON.parse(json) });
  console.log(r.content.map((c) => c.text ?? '').join('\n'));
  code = r.isError ? 1 : 0;
}
await client.close();
process.exit(code);
