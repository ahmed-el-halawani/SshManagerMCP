// End-to-end agent scenario: an agent that follows suggested_plan literally. Prints per call: wall time,
// tokens the agent reads, verdict/plan kind.
//   sandbox (fake ssh, remote = local Git-Bash; see scripts/bench-setup.ts):
//     SSHRM_DATA_DIR=<data> node scripts/agent-scenario.mjs <host_id> <source repo> <remote dir (posix)>
//   real host (uses the host's recipes, like an agent; remote dir defaults to ~/sshrm-scenario):
//     REAL_HOST=1 node scripts/agent-scenario.mjs <host_id> <source repo> [remote dir]
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [hostId, SRC, remoteArg] = process.argv.slice(2);
const REAL = !!process.env.REAL_HOST;
const client = new Client({ name: 'scenario', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp/server.ts'], env: { ...process.env, SSHRM_NO_GUI: '1' }, stderr: 'ignore' }));
let tokens = 0, ms = 0, calls = 0, sshMs = 0;
async function call(name, args) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = r.content[0].text, tok = Math.round(text.length / 4), d = Date.now() - t;
  tokens += tok; ms += d; calls++;
  const o = JSON.parse(text);
  console.log(`  ${r.isError ? 'ERR' : 'ok '} ${name.padEnd(32)} ${String(d).padStart(5)} ms ~${String(tok).padStart(4)} tok ${o.verdict ?? o.outcome ?? o.error?.code ?? ''} ${o.suggested_plan?.kind ?? ''}`);
  if (r.isError) console.log('     ', text.slice(0, 300));
  return o;
}

// How the agent reaches the host: the manager's recipes (real) or Git-Bash standing in for it (sandbox).
const SH = 'C:\\Program Files\\Git\\bin\\sh.exe';
const shEnv = { ...process.env }; delete shEnv.MSYS_NO_PATHCONV;
let remote, put;
if (REAL) {
  const shell = await call('ssh_hosts_get_connection_recipe', { host_id: hostId, caller_environment: 'windows-native' });
  const xfer = await call('ssh_hosts_get_connection_recipe', { host_id: hostId, caller_environment: 'windows-native', purpose: 'file_transfer' });
  const env = { ...process.env, ...shell.env };
  const timed = (f) => { const t = Date.now(); try { return f(); } finally { sshMs += Date.now() - t; } };
  remote = (cmd) => timed(() => execFileSync(shell.argv[0], [...shell.argv.slice(1), cmd], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  put = (local, path) => timed(() => execFileSync(xfer.argv[0], xfer.argv.slice(1).map((a) => a === '<local_path>' ? local : a.replace('<remote_path>', path)), { env, stdio: ['ignore', 'ignore', 'inherit'] }));
} else {
  remote = (cmd) => execFileSync(SH, ['-c', cmd], { env: shEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  put = (local, path) => execFileSync(SH, ['-c', '[ "$1" -ef "$2" ] || cp "$1" "$2"', 'cp', local.replaceAll('\\', '/'), path], { env: shEnv });
}
const REMOTE = remoteArg ?? `${remote('echo $HOME').trim()}/sshrm-scenario`;
if (REAL) remote(`rm -rf '${REMOTE}/demo' && mkdir -p '${REMOTE}'`); // scenario folder only

const git = (...a) => execFileSync('git', ['-c', 'user.email=d@l', '-c', 'user.name=d', '-C', SRC, ...a], { encoding: 'utf8' });
const bundle = `${process.env.TEMP}\\sshrm-sync.bundle`;
/** Runs the plan like an agent: "source:" in PowerShell, "host:" over ssh, copies with scp. */
function follow(plan) {
  for (const step of plan.steps) {
    if (step.startsWith('source: ')) execFileSync('pwsh', ['-NoProfile', '-Command', step.slice(8)], { stdio: 'inherit' });
    else if (step.startsWith('host: ')) remote(step.slice(6)); // pasted as-is
    else if (step.startsWith('copy $env:TEMP')) put(bundle, '/tmp/sshrm-sync.bundle');
    else if (step.startsWith('copy the ')) for (const p of plan.copy) put(`${SRC}/${p}`, `${REMOTE}/demo/${p}`);
  }
}

console.log(`1. register, find, bind (new host folder ${REMOTE}/demo)`);
const proj = await call('ssh_projects_register', { name: 'sshrm-branch-demo', idempotency_key: `s-${Date.now()}`, source_location: { host_id: null, path: SRC } });
await call('ssh_projects_find_on_host', { host_id: hostId, project_id: proj.project.id, search_root: REMOTE });
const bind = await call('ssh_projects_bind_location', { project_id: proj.project.id, host_id: hostId, expected_project_revision: proj.project.revision, idempotency_key: `b-${Date.now()}`, path: `${REMOTE}/demo`, mode: 'create_if_missing' });
const ids = { project_id: proj.project.id, destination_location_id: bind.location.id };
async function cycle(label) {
  console.log(label);
  const pre = await call('ssh_projects_preflight', { ...ids, intent: 'test' });
  if (pre.verdict !== 'ready') {
    if (process.env.SHOW_PLAN) console.log('     plan:', JSON.stringify(pre.suggested_plan));
    follow(pre.suggested_plan);
    const v = await call('ssh_projects_verify_sync', { ...ids, expected_source_snapshot: pre.source_snapshot, operation_id: `op-${Date.now()}`, expected_generations: pre.generations, transfer_mode: 'git_bundle' });
    if (v.outcome !== 'verified') console.log('     verify facts:', JSON.stringify(v.facts).slice(0, 500));
  }
}
try {
  git('switch', '-q', 'main');
  await cycle('2. first sync (main)');
  git('switch', '-q', 'feature/rewrite'); appendFileSync(`${SRC}/app/main.py`, 'print("wip")\n');
  await cycle('3. source switched to a completely different branch + 1 uncommitted edit');
  git('commit', '-qam', 'wip on rewrite');
  await cycle('4. new commit on the same branch');
  remote(`echo host-edit >> '${REMOTE}/demo/app/main.py'`);
  console.log('5. someone edits the host copy');
  await call('ssh_projects_preflight', { ...ids, intent: 'test' });
} finally {
  console.log(`TOTAL ${calls} MCP calls, ${ms} ms in the manager, ${sshMs} ms in agent ssh/scp, ~${tokens} tokens`);
  if (REAL) { await call('ssh_projects_unbind_location', { location_id: bind.location.id, expected_revision: (await call('ssh_projects_get', { project_id: proj.project.id })).locations.find((l) => l.id === bind.location.id).revision }); remote(`rm -rf '${REMOTE}'`); }
  await client.close();
}
