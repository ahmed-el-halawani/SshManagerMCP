/**
 * Password auth for hosts that have no key. The password is encrypted with Windows DPAPI
 * (CurrentUser scope) and stored in host_secrets. It is never returned by any API, never
 * logged, and never passed on a command line or env var: ssh gets it through SSH_ASKPASS,
 * a helper that decrypts it only when sshd actually asks for a password.
 * Honest limit: any process running as this Windows user can decrypt DPAPI data.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DB, now, tx } from './db.ts';
import { AppError } from './errors.ts';

const PS = 'powershell.exe'; // Windows PowerShell 5.1 ships System.Security.ProtectedData; pwsh 7 does not.
const PROTECT = "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,'CurrentUser')))";
export const UNPROTECT = "Add-Type -AssemblyName System.Security; $b=[Console]::In.ReadToEnd(); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($b),$null,'CurrentUser')))";

// ponytail: one powershell spawn per encrypt/decrypt (~300 ms); native DPAPI binding if that ever matters.
function dpapi(script: string, input: string): string {
  if (process.platform !== 'win32') throw new AppError('PROBE_UNSUPPORTED', 'password storage uses Windows DPAPI and is only available on Windows');
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (r.status !== 0) throw new AppError('INTERNAL_ERROR', 'Windows DPAPI call failed', { details: { stderr: (r.stderr ?? '').slice(0, 300) } });
  return r.stdout;
}

export const protect = (plain: string) => dpapi(PROTECT, plain);
export const unprotect = (blob: string) => dpapi(UNPROTECT, blob);

/** password = the host account password (SSH login; on macOS also the login keychain). build_keychain = a random password the manager generated. */
export type SecretKind = 'password' | 'build_keychain';

export function putSecret(db: DB, hostId: string, kind: SecretKind, plain: string) {
  const blob = protect(plain);
  tx(db, () => {
    if (!db.prepare('SELECT 1 FROM hosts WHERE id=?').get(hostId)) throw new AppError('NOT_FOUND', `host ${hostId} not found`);
    db.prepare(`INSERT INTO host_secrets(host_id, kind, secret_blob, updated_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(host_id, kind) DO UPDATE SET secret_blob=excluded.secret_blob, updated_at=excluded.updated_at`).run(hostId, kind, blob, now());
    db.prepare("INSERT INTO audit_events(timestamp, source, action, host_id, details_json) VALUES(?, 'gui', ?, ?, '{}')").run(now(), `set_secret:${kind}`, hostId);
  });
}

/** Decrypts in-process. Callers must hand the result only to a child process's stdin, never to logs, argv, env or API output. */
export function getSecret(db: DB, hostId: string, kind: SecretKind): string | null {
  const r = db.prepare('SELECT secret_blob FROM host_secrets WHERE host_id=? AND kind=?').get(hostId, kind) as { secret_blob: string } | undefined;
  return r ? unprotect(r.secret_blob) : null;
}

export function setHostPassword(db: DB, hostId: string, password: string) {
  if (!password || password.length > 1024 || /[\r\n\0]/.test(password)) throw new AppError('VALIDATION_ERROR', 'password must be 1-1024 characters without newlines');
  putSecret(db, hostId, 'password', password);
  return { host_id: hostId, password_stored: true };
}

export function clearHostPassword(db: DB, hostId: string) {
  db.prepare("DELETE FROM host_secrets WHERE host_id=? AND kind='password'").run(hostId);
  return { host_id: hostId, password_stored: false };
}

export const hasSecret = (db: DB, hostId: string, kind: SecretKind) => !!db.prepare('SELECT 1 FROM host_secrets WHERE host_id=? AND kind=?').get(hostId, kind);
export const hasPassword = (db: DB, hostId: string) => hasSecret(db, hostId, 'password');

/**
 * SSH_ASKPASS must be a single executable path, so a .cmd shim re-enters the current runtime
 * (node, or the app exe as node) with a standalone helper. Rewritten on every start so it
 * always points at the runtime that is actually installed.
 */
/**
 * Prints "<pid>-<start ticks>" of the ssh connection that called us, then the decrypted secret (one powershell spawn for both).
 * Without a console, Windows OpenSSH runs each askpass through a fresh helper ssh.exe child, so the connection is the
 * topmost ssh.exe of the ancestor chain. No ssh.exe ancestor (tests): the grandparent.
 */
const CALLER = `$p=__PPID__; $k=''; $s=0; for($i=0; $i -lt 6 -and $p; $i++){ $c=Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if(-not $c){break}; ` +
  `$id="$($c.ProcessId)-$($c.CreationDate.Ticks)"; if($c.Name -eq 'ssh.exe'){$k=$id; $s=1} elseif($s){break} elseif($i -eq 1){$k=$id}; $p=$c.ParentProcessId }; [Console]::Out.Write("$k\`n"); `;

export function writeAskpass(dataDir: string): string {
  const helper = join(dataDir, 'askpass.mjs');
  const shim = join(dataDir, 'askpass.cmd');
  writeFileSync(helper, `// generated by SSH Resource Manager; do not edit
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const prompt = process.argv[2] ?? '';
// Answer only real password prompts. Host-key confirmations and key passphrases are refused.
if (!/password|passcode/i.test(prompt) || /passphrase/i.test(prompt)) process.exit(1);
const id = process.env.SSHRM_HOST_ID;
if (!id) process.exit(1);
const data = ${JSON.stringify(dataDir)};
const db = new DatabaseSync(join(data, 'registry.db'), { readOnly: true });
const row = db.prepare("SELECT secret_blob FROM host_secrets WHERE host_id=? AND kind='password'").get(id);
db.close();
if (!row) process.exit(1);
const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ${JSON.stringify(CALLER + UNPROTECT)}.replace('__PPID__', String(process.ppid))], { input: row.secret_blob, encoding: 'utf8', windowsHide: true });
if (r.status !== 0) process.exit(1);
const nl = r.stdout.indexOf('\\n');
// Answer once per ssh process. After a wrong password ssh falls back from "password" to "keyboard-interactive"
// and asks again; Windows OpenSSH then hangs reading the second answer (and a second try is a second failed login).
const used = join(data, 'askpass-used');
mkdirSync(used, { recursive: true });
for (const f of readdirSync(used)) { try { if (Date.now() - statSync(join(used, f)).mtimeMs > 600_000) rmSync(join(used, f)); } catch {} }
try { closeSync(openSync(join(used, r.stdout.slice(0, nl) || 'unknown-' + process.ppid), 'wx')); } catch { process.exit(1); }
process.stdout.write(r.stdout.slice(nl + 1) + '\\n');
`);
  writeFileSync(shim, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${helper}" %*\r\n`);
  return shim;
}
