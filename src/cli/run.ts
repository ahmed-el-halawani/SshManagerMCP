/**
 * Runs one remote command on a Mac with its keychain unlocked in the same SSH session (see core/signing.ts).
 *   <app exe or node> run.js --data-dir=<dir> --host=<host_id> -- "<remote command>"
 * Output and exit code are passed through. The keychain secret goes to ssh's stdin only.
 */
import { spawn } from 'node:child_process';
import { createCore, errorPayload } from '../core/index.ts';
import { COMMAND_ENV, prepareSignedRun, setupBuildKeychain, WRAPPER_EXIT } from '../core/signing.ts';
import { childEnv } from '../core/ssh.ts';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opt = (k: string) => argv.slice(0, sep < 0 ? undefined : sep).find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const command = (sep < 0 ? '' : argv.slice(sep + 1).join(' ')) || process.env[COMMAND_ENV];
const hostId = opt('host');
if (!hostId || !command) {
  process.stderr.write(`usage: run.js --data-dir=<dir> --host=<host_id> [-- "<remote command>"]   (or the command in env ${COMMAND_ENV})\n`);
  process.exit(2);
}

const core = createCore({ dataDir: opt('data-dir'), source: 'internal' });

async function once() {
  const plan = await prepareSignedRun(core.ctx, { host_id: hostId!, command: command! });
  const [exe, ...pre] = plan.command;
  return new Promise<number>((resolve) => {
    const child = spawn(exe, [...pre, ...plan.args], { env: childEnv(plan.env), stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    child.on('error', (e) => { process.stderr.write(`sshrm: could not start ssh: ${e.message}\n`); resolve(255); });
    child.stdin.end(plan.stdin);
    child.on('close', (code) => resolve(code ?? 255));
  });
}

try {
  let code = await once();
  // The build keychain vanished on the Mac (deleted, Mac reinstalled): rebuild it once and retry. The command never ran.
  if (code === WRAPPER_EXIT.build_keychain_missing && core.getHost({ host_id: hostId }).signing.mode === 'build_keychain') {
    process.stderr.write('sshrm: build keychain missing; setting it up again\n');
    await setupBuildKeychain(core.ctx, { host_id: hostId });
    code = await once();
  }
  core.close();
  process.exit(code);
} catch (e) {
  process.stderr.write(`sshrm: ${JSON.stringify(errorPayload(e))}\n`);
  core.close();
  process.exit(3);
}
