/**
 * Switch a password host to key auth, using the stored password once to install the key.
 * The key is generated here (ed25519, no passphrase so BatchMode and agents work; protected by an
 * owner-only ACL), the public half is sent over SSH stdin and appended to ~/.ssh/authorized_keys,
 * and the profile changes only after a key-only login has actually worked. The password is kept
 * (macOS login-keychain signing still needs it). Direct POSIX hosts only.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { sshRun, type Ctx } from './checks.ts';
import { AppError } from './errors.ts';
import { getHostRow, profileOf, updateHost } from './hosts.ts';
import { hasPassword } from './secrets.ts';
import { getSettings } from './settings.ts';
import { ensureInclude, restrictToOwner, sshAlias, writeSshConfig } from './sshconfig.ts';
import { run, sanitize, splitCommand, sshArgs } from './ssh.ts';

// Exit codes: 97 no key on stdin, 10-12 a step failed. A file without a trailing newline gets one first,
// or the key would be glued onto its last line.
const INSTALL_SCRIPT = `umask 077; IFS= read -r K || exit 97
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" || exit 10
F="$HOME/.ssh/authorized_keys"; touch "$F" && chmod 600 "$F" || exit 11
grep -qxF "$K" "$F" || { [ -s "$F" ] && [ -n "$(tail -c 1 "$F")" ] && echo >> "$F"; printf '%s\\n' "$K" >> "$F"; } || exit 12
echo @@OK`;

export const hostKeyPath = (dataDir: string, hostId: string) => join(dataDir, 'keys', `${hostId}_ed25519`);

async function ensureKey(ctx: Ctx, hostId: string): Promise<{ path: string; pub: string }> {
  const path = hostKeyPath(ctx.dataDir, hostId);
  if (!existsSync(path) || !existsSync(`${path}.pub`)) {
    mkdirSync(join(ctx.dataDir, 'keys'), { recursive: true });
    rmSync(path, { force: true }); rmSync(`${path}.pub`, { force: true });
    const r = await run(splitCommand(getSettings(ctx.db).ssh_keygen_path), ['-q', '-t', 'ed25519', '-N', '', '-C', `sshrm:${hostId}`, '-f', path], { timeoutMs: 20_000 });
    if (r.exit_code !== 0) throw new AppError('INTERNAL_ERROR', `ssh-keygen failed: ${sanitize(r.stderr || r.spawn_error || '').slice(0, 300)}`);
    const acl = restrictToOwner(path); // Windows OpenSSH refuses a private key that anyone else can read
    if (acl) throw new AppError('INTERNAL_ERROR', `could not restrict the key file permissions: ${sanitize(acl).slice(0, 300)}`);
  }
  const pub = readFileSync(`${path}.pub`, 'utf8').trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ sshrm:\S+$/.test(pub)) throw new AppError('INTERNAL_ERROR', 'generated public key has an unexpected format');
  return { path, pub };
}

/** GUI only: the user decides to change how the manager logs in. No MCP tool exists. */
export async function switchToKeyAuth(ctx: Ctx, raw: unknown) {
  const input = z.object({ host_id: z.uuid() }).strict().parse(raw);
  const row = getHostRow(ctx.db, input.host_id);
  const p = profileOf(row);
  if (p.mode !== 'direct') throw new AppError('VALIDATION_ERROR', 'alias hosts take their auth from your ~/.ssh/config, which the manager never edits');
  if (p.auth !== 'password') throw new AppError('VALIDATION_ERROR', 'this host already uses key auth');
  const os = row.observed_os ?? row.declared_os;
  if (os !== 'macos' && os !== 'linux') throw new AppError('PROBE_UNSUPPORTED', `key setup supports macOS and Linux hosts; this host is ${os}. Run a host check first if that is wrong.`);
  if (!hasPassword(ctx.db, row.id)) throw new AppError('AUTH_REQUIRED', 'the key is installed by logging in with the stored password; set it first');

  const key = await ensureKey(ctx, row.id);
  const inst = await sshRun(ctx, row, INSTALL_SCRIPT, 30, { input: `${key.pub}\n` });
  if (!inst.stdout.includes('@@OK')) {
    throw new AppError(inst.exit_code === 255 ? 'AUTH_REQUIRED' : 'REMOTE_COMMAND_FAILED', `installing the key failed (exit ${inst.exit_code}): ${sanitize(inst.stderr).slice(0, 300)}`,
      { details: { host_id: row.id }, next_action: 'Run Check now with password auth first; nothing was changed' });
  }

  // Prove the key works on its own before switching: BatchMode=yes, pubkey only.
  const keyProfile = { ...p, auth: 'key' as const, identity_file: key.path, identities_only: true };
  const s = getSettings(ctx.db);
  const { args, env } = sshArgs(keyProfile, ctx.dataDir, s, 'echo @@KEYOK', row.id);
  const test = await run(splitCommand(s.ssh_path), args, { timeoutMs: s.check_timeout_s * 1000, env });
  if (!test.stdout.includes('@@KEYOK')) {
    throw new AppError('AUTH_REQUIRED', `the key was added to authorized_keys, but a key-only login failed: ${sanitize(test.stderr).slice(0, 300)}`, {
      details: { host_id: row.id },
      next_action: 'The host still uses the password. Common causes: sshd has PubkeyAuthentication no, or your home folder is group/world-writable (sshd StrictModes).',
    });
  }
  const r = updateHost(ctx.db, ctx.source, { host_id: row.id, expected_revision: row.revision, idempotency_key: randomUUID(), patch: { profile: keyProfile } });
  writeSshConfig(ctx.db, ctx.dataDir);
  ensureInclude(ctx.dataDir);
  const alias = sshAlias(ctx.db, ctx.dataDir, row.id);
  return { host: r.host, identity_file: key.path, ssh_alias: alias,
    note: `Key auth is on${alias ? `; from any terminal: ssh ${alias}` : ''}. The password stays stored (macOS login-keychain signing uses it); forget it in Edit if you do not need it.` };
}
