import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { ErrorCode } from './errors.ts';
import type { Profile } from './schemas.ts';
import type { Settings } from './settings.ts';

export const MAX_STREAM = 64 * 1024;

export type RunResult = {
  exit_code: number | null; signal: string | null; stdout: string; stderr: string;
  stdout_truncated: boolean; stderr_truncated: boolean; timed_out: boolean; duration_ms: number; spawn_error?: string;
};

/**
 * spawn with shell:false, separate bounded streams, hard wall-clock timeout that kills the
 * whole local process tree. `command` may carry a prefix (tests use [node, fake-ssh.mjs]).
 */
/**
 * MCP clients often start servers with a minimal env (the MCP SDK default has no ProgramData).
 * Windows OpenSSH then exits 255 with no output, because it resolves __PROGRAMDATA__\ssh from it.
 */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (process.platform === 'win32' && !Object.keys(env).some((k) => k.toLowerCase() === 'programdata')) {
    env.ProgramData = `${env.SystemDrive ?? env.SYSTEMDRIVE ?? 'C:'}\\ProgramData`;
  }
  return env;
}

export function run(command: string[], args: string[], opts: { timeoutMs: number; maxBytes?: number; input?: string; cwd?: string; signal?: AbortSignal; env?: Record<string, string> }): Promise<RunResult> {
  const max = opts.maxBytes ?? MAX_STREAM;
  const started = Date.now();
  return new Promise((resolve) => {
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], so: 0, se: 0, st: false, et: false };
    let timedOut = false;
    let spawnError: string | undefined;
    const child = spawn(command[0], [...command.slice(1), ...args], { shell: false, windowsHide: true, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(opts.env) });
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', kill, { once: true });
    const collect = (name: 'stdout' | 'stderr') => (b: Buffer) => {
      const key = name === 'stdout' ? 'so' : 'se';
      const room = max - out[key];
      if (room <= 0) { out[name === 'stdout' ? 'st' : 'et'] = true; return; }
      if (b.length > room) out[name === 'stdout' ? 'st' : 'et'] = true;
      out[name].push(b.subarray(0, room));
      out[key] += Math.min(b.length, room);
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (e) => { spawnError = (e as NodeJS.ErrnoException).code ?? e.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      resolve({
        exit_code: code, signal: sig, stdout: Buffer.concat(out.stdout).toString('utf8'), stderr: Buffer.concat(out.stderr).toString('utf8'),
        stdout_truncated: out.st, stderr_truncated: out.et, timed_out: timedOut, duration_ms: Date.now() - started, spawn_error: spawnError,
      });
    });
  });
}

export const splitCommand = (path: string): string[] => {
  // Settings may hold a JSON array (test seam) or a plain executable path.
  if (path.startsWith('[')) return JSON.parse(path);
  return [path];
};

/** ssh -o values are parsed like ssh_config lines: quote them and use forward slashes on Windows. */
export const cfgPath =(p: string) => `"${process.platform === 'win32' ? p.replaceAll('\\', '/') : p}"`;

export const knownHostsPath = (dataDir: string) => join(dataDir, 'known_hosts');

/**
 * Common argv for both probes and agent recipes. Never disables host key checking.
 * Direct profiles use the app's own known_hosts; aliases keep the user's ssh_config semantics.
 */
export function sshBaseArgs(p: Profile, dataDir: string, s: Settings, forScp = false, hostId = ''): { args: string[]; destination: string; env: Record<string, string> } {
  const password = p.auth === 'password';
  // Password hosts: BatchMode must be off for askpass, but the answer comes only from our helper
  // (SSH_ASKPASS_REQUIRE=force), never a TTY, so nothing can hang waiting for input.
  const args = ['-o', `BatchMode=${password ? 'no' : 'yes'}`, '-o', 'StrictHostKeyChecking=yes', '-o', `ConnectTimeout=${s.connect_timeout_s}`,
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];
  if (password) args.push('-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1');
  const env: Record<string, string> = password
    ? { SSH_ASKPASS: join(dataDir, 'askpass.cmd'), SSH_ASKPASS_REQUIRE: 'force', SSHRM_HOST_ID: hostId }
    : {};
  if (p.config_path) args.push('-F', p.config_path);
  if (p.mode === 'ssh_alias') return { args, destination: p.alias, env };
  args.push('-o', `UserKnownHostsFile=${cfgPath(knownHostsPath(dataDir))}`);
  if (p.identity_file) args.push('-i', p.identity_file);
  if (p.identities_only) args.push('-o', 'IdentitiesOnly=yes');
  if (p.proxy_jump?.length) args.push('-J', p.proxy_jump.join(','));
  args.push(forScp ? '-P' : '-p', String(p.port), '-o', `User=${p.username}`);
  return { args, destination: p.hostname, env };
}

export function sshArgs(p: Profile, dataDir: string, s: Settings, remoteCommand: string, hostId: string): { args: string[]; env: Record<string, string> } {
  const { args, destination, env } = sshBaseArgs(p, dataDir, s, false, hostId);
  return { args: [...args, '-T', '--', destination, remoteCommand], env };
}

/** Classify an ssh failure from diagnostics. Unknown stays unknown; timeout is not "powered off". */
export function classify(r: RunResult): { code: ErrorCode; message: string; next_action?: string } {
  const e = r.stderr;
  if (r.spawn_error === 'ENOENT') return { code: 'SSH_NOT_INSTALLED', message: 'ssh executable not found', next_action: 'Install Windows OpenSSH Client or set ssh_path in Setup' };
  if (r.stdout_truncated) return { code: 'OUTPUT_LIMIT', message: 'remote output exceeded the probe limit' };
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(e)) return { code: 'HOST_KEY_CHANGED', message: 'The host key differs from the trusted key. Possible reinstall or MITM.', next_action: 'Verify the new key out-of-band; the old key is never replaced automatically' };
  if (/No .* host key is known|Host key verification failed/i.test(e)) return { code: 'TRUST_REQUIRED', message: 'Host key is not trusted yet', next_action: 'Compare the candidate fingerprint with one obtained from the machine itself, then approve_host_key' };
  if (/Could not resolve hostname|Name or service not known|No such host is known/i.test(e)) return { code: 'DNS_FAILED', message: 'Hostname could not be resolved' };
  if (/Connection refused/i.test(e)) return { code: 'CONNECTION_REFUSED', message: 'Connection refused (sshd not listening on that port, or blocked)' };
  if (/No route to host|Network is unreachable/i.test(e)) return { code: 'NETWORK_UNREACHABLE', message: 'Network/route unreachable' };
  if (r.timed_out || /timed out/i.test(e)) return { code: 'CONNECTION_TIMEOUT', message: 'Timed out. The host may be off, firewalled, or the address wrong.' };
  if (/Permission denied|Too many authentication failures|passphrase|no such identity/i.test(e)) return { code: 'AUTH_REQUIRED', message: 'Authentication failed in non-interactive mode', next_action: 'Key auth: load the key into ssh-agent (ssh-add) or set identity_file. Password auth: the user sets/updates the password in the GUI host editor (never through chat).' };
  if (r.exit_code === 255) return { code: 'INTERNAL_ERROR', message: 'ssh failed (exit 255) with unrecognised diagnostics' };
  return { code: 'REMOTE_COMMAND_FAILED', message: `remote command exited with ${r.exit_code}` };
}

/** Redact anything that looks like a credential before it touches DB/logs/tool output. */
export const sanitize = (s: string) => s
  .replace(/(:\/\/)[^/@\s]+@/g, '$1***@')
  .replace(/(password|passphrase|token|secret)\s*[=:]\s*\S+/gi, '$1=***')
  .slice(0, 4000);

export function diagnostics(r: RunResult) {
  return {
    exit_code: r.exit_code, timed_out: r.timed_out, duration_ms: r.duration_ms,
    stderr: sanitize(r.stderr), stderr_truncated: r.stderr_truncated, stdout_truncated: r.stdout_truncated, spawn_error: r.spawn_error,
  };
}

export const posixQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
export const psQuote = (s: string) => (/^[\w./:\\=@,+-]+$/.test(s) ? s : `'${s.replaceAll("'", "''")}'`);
