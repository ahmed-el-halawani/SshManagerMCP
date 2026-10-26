// End-to-end agent scenario against the bench sandbox (scripts/bench-setup.ts): an agent that follows
// suggested_plan literally. Prints per call: wall time, tokens the agent reads, verdict/plan kind.
// usage: SSHRM_DATA_DIR=<data> node scripts/agent-scenario.mjs <host_id> <source repo> <remote dir (posix)>
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [hostId, SRC, REMOTE] = process.argv.slice(2);
const client = new Client({ name: 'scenario', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp/server.ts'], env: { ...process.env, SSHRM_NO_GUI: '1' }, stderr: 'ignore' }));
let tokens = 0, ms = 0, calls = 0;
async function call(name, args) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = r.content[0].text, tok = Math.round(text.length / 4), d = Date.now() - t;
  tokens += tok; ms += d; calls++;
  const o = JSON.parse(text);
  console.log(`  ${r.isError ? 'ERR' : 'ok '} ${name.padEnd(30)} ${String(d).padStart(5)} ms ~${String(tok).padStart(4)} tok ${o.verdict ?? o.outcome ?? o.error?.code ?? ''} ${o.suggested_plan?.kind ?? ''}`);
  if (r.isError) console.log("     ", text.slice(0, 300));
  return o;
}
const SH = 'C:\\Program Files\\Git\\bin\\sh.exe';
const shEnv = { ...process.env }; delete shEnv.MSYS_NO_PATHCONV; // the fake remote is Git-Bash: let it map /tmp like a real shell
const sh = (cmd, ...args) => execFileSync(SH, ["-c", cmd, "sh", ...args], { stdio: "inherit", env: shEnv });
const git = (...a) => execFileSync('git', ['-c', 'user.email=d@l', '-c', 'user.name=d', '-C', SRC, ...a], { encoding: 'utf8' });
/** Runs the plan like an agent: "source:" in PowerShell, "host:" in the remote's sh, "copy ..." steps by hand. */
function follow(plan) {
  for (const step of plan.steps) {
    if (step.startsWith('source: ')) execFileSync('pwsh', ['-NoProfile', '-Command', step.slice(8)], { stdio: 'inherit' });
    else if (step.startsWith("host: ")) sh(step.slice(6)); // pasted as-is, like an agent would
    else if (step.startsWith("copy $env:TEMP")) sh("[ \"$1\" -ef /tmp/sshrm-sync.bundle ] || cp \"$1\" /tmp/sshrm-sync.bundle", `${process.env.TEMP}/sshrm-sync.bundle`.replaceAll("\\", "/")); // = scp
    else if (step.startsWith("copy the ")) for (const p of plan.copy) sh("cp \"$1\" \"$2\"", `${SRC}/${p}`.replaceAll("\\", "/"), `${REMOTE}/demo/${p}`);
  }
}

console.log('1. register, find, bind (new host folder), preflight -> clone plan');
const proj = await call('ssh_projects_register', { name: 'sshrm-branch-demo', idempotency_key: `s-${Date.now()}`, source_location: { host_id: null, path: SRC } });
await call('ssh_projects_find_on_host', { host_id: hostId, project_id: proj.project.id, search_root: REMOTE });
const bind = await call('ssh_projects_bind_location', { project_id: proj.project.id, host_id: hostId, expected_project_revision: proj.project.revision, idempotency_key: `b-${Date.now()}`, path: `${REMOTE}/demo`, mode: 'create_if_missing' });
const ids = { project_id: proj.project.id, destination_location_id: bind.location.id };
async function cycle(label) {
  console.log(label);
  let pre = await call('ssh_projects_preflight', { ...ids, intent: 'test' });
  if (pre.verdict !== 'ready') {
    console.log('     plan:', JSON.stringify(pre.suggested_plan).slice(0, 600));
    follow(pre.suggested_plan);
    const v = await call('ssh_projects_verify_sync', { ...ids, expected_source_snapshot: pre.source_snapshot, operation_id: `op-${Date.now()}`, expected_generations: pre.generations, transfer_mode: 'git_bundle' });
    if (v.outcome !== 'verified') console.log('     verify facts:', JSON.stringify(v.facts).slice(0, 500));
  }
}
git('switch', '-q', 'main');
await cycle('2. first sync (main)');
git('switch', '-q', 'feature/rewrite'); appendFileSync(`${SRC}/app/main.py`, 'print("wip")\n');
await cycle('3. source switched to a completely different branch + 1 uncommitted edit');
git('commit', '-qam', 'wip on rewrite');
await cycle('4. new commit on the same branch');
sh(`echo host-edit >> "${REMOTE}/demo/app/main.py"`);
console.log('5. someone edits the host copy');
await call('ssh_projects_preflight', { ...ids, intent: 'test' });
console.log(`TOTAL ${calls} calls, ${ms} ms, ~${tokens} tokens`);
await client.close();
