import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type DB, now, tx } from './db.ts';
import { AppError } from './errors.ts';
import { audit, getHost, getHostRow, profileOf, targetSummary, type HostRow } from './hosts.ts';
import { executionEnvironment } from './paths.ts';
import type { Profile, Source } from './schemas.ts';
import { getSettings, type Settings } from './settings.ts';
import { hasPassword } from './secrets.ts';
import { signingRecipe } from './signing.ts';
import { cfgPath, classify, diagnostics, knownHostsPath, psQuote, posixQuote, run, sanitize, splitCommand, sshArgs, sshBaseArgs, type RunResult } from './ssh.ts';

export type Ctx = { db: DB; dataDir: string; source: Source };

const PROBE_VERSION = '1';
const marker = () => `__SSHRM_${randomUUID().slice(0, 8)}__`;
const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim());

// With no stored password the askpass helper declines, so ssh still reports trust problems first.
export async function sshRun(ctx: Ctx, row: HostRow, cmd: string, timeoutS: number, extra: { maxBytes?: number; input?: string } = {}): Promise<RunResult> {
  const s = getSettings(ctx.db);
  const p = profileOf(row);
  const { args, env } = sshArgs(p, ctx.dataDir, s, cmd, row.id);
  const r = await run(splitCommand(s.ssh_path), args, { timeoutMs: timeoutS * 1000, env, ...extra });
  if (p.auth === 'password' && /Permission denied/i.test(r.stderr) && !hasPassword(ctx.db, row.id)) r.stderr += '\n(no password is stored for this host; set it in the GUI host editor)';
  return r;
}

type OsResult = { ok: true; os: 'macos' | 'linux' | 'windows' | 'unknown'; detail: string; shell: 'posix' | 'windows'; out?: string } | { ok: false; run: RunResult };

/** OS bootstrap: POSIX first unless hinted Windows; fallback once. A failed POSIX command on Windows is not an auth failure. */
async function detectOs(ctx: Ctx, row: HostRow, timeoutS: number): Promise<OsResult> {
  const hint = row.observed_os ?? row.declared_os;
  const tryPosix = async (): Promise<OsResult | 'fallback'> => {
    const m = marker();
    // macOS session checks ride along in the same connection: every SSH login costs a handshake (and askpass + DPAPI for password hosts)
    const r = await sshRun(ctx, row, `echo ${m}; uname -sr; [ "$(uname)" = Darwin ] && { ${MACOS_SESSION_SCRIPT}; }`, timeoutS);
    const ls = lines(r.stdout);
    if (r.stdout_truncated) return { ok: false, run: r };
    if (!ls.includes(m)) return r.exit_code === 255 || r.timed_out || r.spawn_error ? { ok: false, run: r } : 'fallback';
    const u = ls[ls.indexOf(m) + 1] ?? '';
    if (/^Darwin/.test(u)) return { ok: true, os: 'macos', detail: u, shell: 'posix', out: r.stdout };
    if (/^Linux/.test(u)) return { ok: true, os: 'linux', detail: u, shell: 'posix' };
    if (/^(MINGW|MSYS|CYGWIN)/.test(u)) return { ok: true, os: 'windows', detail: u, shell: 'posix' };
    if (u && !/not recognized|not found/i.test(u + r.stderr)) return { ok: true, os: 'unknown', detail: u, shell: 'posix' };
    return 'fallback';
  };
  const tryWindows = async (): Promise<OsResult | 'fallback'> => {
    const m = marker();
    const r = await sshRun(ctx, row, `cmd /c "echo ${m}&& ver"`, timeoutS);
    const ls = lines(r.stdout);
    if (r.stdout_truncated) return { ok: false, run: r };
    if (!ls.includes(m)) return r.exit_code === 255 || r.timed_out || r.spawn_error ? { ok: false, run: r } : 'fallback';
    const v = ls.find((l) => /Microsoft Windows/i.test(l)) ?? '';
    return { ok: true, os: v ? 'windows' : 'unknown', detail: v, shell: 'windows' };
  };
  const order = hint === 'windows' ? [tryWindows, tryPosix] : [tryPosix, tryWindows];
  let last: OsResult | 'fallback' = 'fallback';
  for (const f of order) {
    last = await f();
    if (last !== 'fallback') return last;
  }
  return { ok: true, os: 'unknown', detail: 'session opened but OS could not be determined', shell: 'posix' };
}

function acquireCheckLease(ctx: Ctx, row: HostRow, kind: 'connectivity' | 'capability', s: Settings) {
  return tx(ctx.db, () => {
    const t = now();
    ctx.db.prepare('DELETE FROM check_leases WHERE expires_at<=?').run(t);
    const held = ctx.db.prepare('SELECT check_id FROM check_leases WHERE host_id=?').get(row.id) as { check_id: string } | undefined;
    if (held) throw new AppError('CHECK_IN_PROGRESS', 'a check for this host is already running', { retryable: true, details: { host_id: row.id, check_id: held.check_id } });
    const id = randomUUID();
    const expires = new Date(Date.now() + (s.check_timeout_s * 2 + s.probe_timeout_s * 4 + 10) * 1000).toISOString();
    ctx.db.prepare('INSERT INTO check_leases(host_id, check_id, expires_at) VALUES(?,?,?)').run(row.id, id, expires);
    ctx.db.prepare(`INSERT INTO checks(id, host_id, host_revision, identity_generation, kind, started_at, probe_version, effective_target_summary) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, row.id, row.revision, row.identity_generation, kind, t, PROBE_VERSION, targetSummary(profileOf(row)));
    return id;
  });
}

function finishCheck(ctx: Ctx, row: HostRow, checkId: string, started: number, outcome: 'success' | 'failure', errorCode: string | null, diag: object, os?: { os: string; detail: string }) {
  const s = getSettings(ctx.db);
  return tx(ctx.db, () => {
    ctx.db.prepare('UPDATE checks SET finished_at=?, outcome=?, error_code=?, diagnostics_json=?, duration_ms=? WHERE id=?')
      .run(now(), outcome, errorCode, JSON.stringify(diag), Date.now() - started, checkId);
    ctx.db.prepare('DELETE FROM check_leases WHERE host_id=? AND check_id=?').run(row.id, checkId);
    const cur = ctx.db.prepare('SELECT identity_generation FROM hosts WHERE id=?').get(row.id) as { identity_generation: number } | undefined;
    // Host deleted or its endpoint changed mid-check: keep as history only, never colour the new target.
    const applied = !!cur && cur.identity_generation === row.identity_generation;
    if (applied) {
      ctx.db.prepare('UPDATE hosts SET last_check_id=? WHERE id=?').run(checkId, row.id);
      if (os) ctx.db.prepare('UPDATE hosts SET observed_os=?, observed_os_detail=? WHERE id=?').run(os.os, os.detail, row.id);
    }
    ctx.db.prepare(`DELETE FROM checks WHERE host_id=? AND id NOT IN (SELECT id FROM checks WHERE host_id=? ORDER BY started_at DESC LIMIT ?)`)
      .run(row.id, row.id, s.checks_retained_per_host);
    return applied;
  });
}

export async function checkHost(ctx: Ctx, raw: unknown) {
  const { host_id } = z.object({ host_id: z.uuid() }).strict().parse(raw);
  const row = getHostRow(ctx.db, host_id);
  const s = getSettings(ctx.db);
  const checkId = acquireCheckLease(ctx, row, 'connectivity', s);
  const started = Date.now();
  let res: OsResult;
  try {
    res = await detectOs(ctx, row, s.check_timeout_s);
  } catch (e) {
    finishCheck(ctx, row, checkId, started, 'failure', 'INTERNAL_ERROR', { error: sanitize(String(e)) });
    throw e;
  }
  const checked_at = now();
  if (res.ok) {
    const warnings = res.os === 'macos' ? macosSessionWarnings(res.out ?? '') : [];
    const applied = finishCheck(ctx, row, checkId, started, 'success', null, { shell: res.shell, warnings }, res);
    return {
      success: true, check_id: checkId, host_id, checked_at, state: 'reachable', applied_to_current_profile: applied, warnings,
      observed_os: res.os, observed_os_detail: res.detail, declared_os: row.declared_os,
      os_mismatch: row.declared_os !== 'unknown' && res.os !== 'unknown' && res.os !== row.declared_os,
      note: 'SSH login works. This says nothing about tools or devices; probe capabilities separately.',
    };
  }
  const c = classify(res.run);
  if (c.code === 'AUTH_REQUIRED') c.next_action = profileOf(row).auth === 'password'
    ? 'The host rejected the stored username/password. Ask the user to correct them in the SSH Resource Manager app (host → Edit). Never ask for the password in chat.'
    : 'Load the key into ssh-agent (ssh-add) or set identity_file on the host.';
  const diag = diagnostics(res.run);
  const applied = finishCheck(ctx, row, checkId, started, 'failure', c.code, diag);
  const candidates = c.code === 'TRUST_REQUIRED' ? await candidateFingerprints(ctx, profileOf(row)).catch((e) => ({ error: String(e.message ?? e) })) : undefined;
  return {
    success: false, check_id: checkId, host_id, checked_at, applied_to_current_profile: applied,
    error: { code: c.code, message: c.message, retryable: ['CONNECTION_TIMEOUT', 'NETWORK_UNREACHABLE', 'DNS_FAILED'].includes(c.code), next_action: c.next_action, diagnostics: diag },
    ...(candidates ? { trust_candidates: candidates, trust_note: 'Candidates come from an unauthenticated keyscan and are NOT proof of identity. Compare with a fingerprint read on the machine itself (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub).' } : {}),
  };
}

export type SessionWarning = { code: string; message: string; fix: string };

/**
 * Learned the hard way: macOS privacy (TCC) hides ~/Documents, ~/Desktop, ~/Downloads from SSH
 * sessions unless "Allow full disk access for remote users" is on, and a login profile that
 * sources files from there breaks every tool it was meant to set up (flutter, pod, node...).
 */
const MACOS_SESSION_SCRIPT = `for d in Documents Desktop Downloads; do [ -d "$HOME/$d" ] && { ls "$HOME/$d" >/dev/null 2>&1 || echo "@@TCC $d"; }; done
zsh -lc true 2>&1 | grep -i "not permitted" | head -n 3 | sed 's/^/@@PROFILE /'; echo @@END`;

function macosSessionWarnings(stdout: string): SessionWarning[] {
  if (!stdout.includes('@@END')) return [];
  const out: SessionWarning[] = [];
  const blocked = [...stdout.matchAll(/^@@TCC (\w+)/gm)].map((m) => `~/${m[1]}`);
  if (blocked.length) out.push({ code: 'MACOS_PRIVACY_BLOCKED', message: `SSH sessions cannot read ${blocked.join(', ')} (macOS privacy/TCC). Tools, SDKs or projects stored there are invisible over SSH.`,
    fix: 'On the Mac: System Settings → General → Sharing → Remote Login (i) → enable "Allow full disk access for remote users". Or keep projects/tools outside those folders.' });
  const profile = [...stdout.matchAll(/^@@PROFILE (.+)$/gm)].map((m) => m[1].trim());
  if (profile.length) out.push({ code: 'LOGIN_PROFILE_ERROR', message: `The login shell profile fails over SSH: ${profile[0].slice(0, 200)}`,
    fix: 'Tools it adds to PATH (flutter, pod, node, brew) may be missing in SSH commands. Fix the profile, enable full disk access, or call tools by absolute path (see probe results).' });
  return out;
}

// ---- trust ----

type Candidate = { algorithm: string; fingerprint: string; bits: string; line: string };

async function candidateFingerprints(ctx: Ctx, p: Profile): Promise<Candidate[]> {
  if (p.mode !== 'direct') throw new AppError('PROBE_UNSUPPORTED', 'alias hosts use your own known_hosts; connect once in a terminal and verify the key there');
  const s = getSettings(ctx.db);
  // Capture the offered key with ssh itself (same KEX as real connections; Windows' ssh-keyscan 9.5
  // cannot negotiate with OpenSSH 10 servers). It goes to a throwaway file, never the trusted
  // known_hosts, and every auth method is disabled so no credential is ever sent.
  const tmp = join(ctx.dataDir, `candidate-${randomUUID()}.known_hosts`);
  const base = sshBaseArgs({ ...p, auth: 'key' }, ctx.dataDir, s);
  const args = base.args.map((a) => (a === 'StrictHostKeyChecking=yes' ? 'StrictHostKeyChecking=accept-new' : a.startsWith('UserKnownHostsFile=') ? `UserKnownHostsFile=${cfgPath(tmp)}` : a));
  const scan = await run(splitCommand(s.ssh_path), [...args, '-o', 'HashKnownHosts=no', '-o', 'GlobalKnownHostsFile=none', '-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no', '-o', 'GSSAPIAuthentication=no', '-o', 'HostbasedAuthentication=no', '-T', '--', base.destination, 'exit'], { timeoutMs: s.check_timeout_s * 1000 });
  const keyLines = existsSync(tmp) ? readFileSync(tmp, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')) : [];
  rmSync(tmp, { force: true });
  if (!keyLines.length) throw new AppError('CONNECTION_TIMEOUT', 'could not obtain the host key', { details: { diagnostics: diagnostics(scan) } });
  const out: Candidate[] = [];
  for (const line of keyLines) {
    const fp = await run(splitCommand(s.ssh_keygen_path), ['-lf', '-'], { timeoutMs: 10_000, input: line + '\n' });
    const m = /^(\d+)\s+(SHA256:\S+)\s+.*\((\w+)\)\s*$/.exec(fp.stdout.trim());
    if (m) out.push({ bits: m[1], fingerprint: m[2], algorithm: m[3], line });
  }
  return out;
}

export async function approveHostKey(ctx: Ctx, raw: unknown) {
  const input = z.object({ host_id: z.uuid(), fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/=]+$/), algorithm: z.string().min(2).max(40), expected_identity_generation: z.number().int() }).strict().parse(raw);
  const row = getHostRow(ctx.db, input.host_id);
  if (row.identity_generation !== input.expected_identity_generation) {
    throw new AppError('REVISION_CONFLICT', 'connection settings changed since this fingerprint was shown; re-check', { details: { host_id: row.id, current_identity_generation: row.identity_generation } });
  }
  const p = profileOf(row);
  if (p.mode !== 'direct') throw new AppError('PROBE_UNSUPPORTED', 'alias hosts use your own known_hosts; this app does not modify it');
  const s = getSettings(ctx.db);
  const kh = knownHostsPath(ctx.dataDir);
  const lookup = p.port === 22 ? p.hostname : `[${p.hostname}]:${p.port}`;
  if (existsSync(kh)) {
    const existing = await run(splitCommand(s.ssh_keygen_path), ['-F', lookup, '-f', kh], { timeoutMs: 10_000 });
    if (existing.stdout.trim()) {
      throw new AppError('HOST_KEY_CHANGED', 'a key for this endpoint is already trusted; it is never replaced automatically', {
        details: { host_id: row.id }, next_action: `If you verified the new key out-of-band, remove the old entry yourself: ssh-keygen -R "${lookup}" -f "${kh}", then approve again`,
      });
    }
  }
  const cands = await candidateFingerprints(ctx, p);
  const match = cands.find((c) => c.fingerprint === input.fingerprint && c.algorithm.toUpperCase() === input.algorithm.toUpperCase());
  if (!match) throw new AppError('VALIDATION_ERROR', 'the host is not currently offering that fingerprint/algorithm', { details: { offered: cands.map(({ line: _l, ...c }) => c) } });
  appendFileSync(kh, match.line.trim() + '\n');
  tx(ctx.db, () => {
    ctx.db.prepare('INSERT INTO host_trust(host_id, target_host, target_port, algorithm, fingerprint, approved_at, source, identity_generation) VALUES(?,?,?,?,?,?,?,?)')
      .run(row.id, p.hostname, p.port, match.algorithm, match.fingerprint, now(), ctx.source, row.identity_generation);
    audit(ctx.db, ctx.source, 'approve_host_key', row.id, row.revision, row.revision, { fingerprint: match.fingerprint, algorithm: match.algorithm });
  });
  return { trusted: true, host_id: row.id, fingerprint: match.fingerprint, algorithm: match.algorithm, known_hosts: kh, next_action: 'check_host' };
}

// ---- capability probes (built-in only) ----

const BIN = /^[A-Za-z0-9._+-]{1,64}$/;
export const KNOWN_BIN_DIRS = '"$HOME/development/flutter/bin" "$HOME/flutter/bin" "$HOME/fvm/default/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.pub-cache/bin" "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.gem/bin"';

export async function probeCapabilities(ctx: Ctx, raw: unknown) {
  const input = z.object({ host_id: z.uuid(), probe_ids: z.array(z.string().min(2).max(80)).min(1).max(10) }).strict().parse(raw);
  const row = getHostRow(ctx.db, input.host_id);
  const s = getSettings(ctx.db);
  for (const id of input.probe_ids) {
    if (!(id === 'macos.xcode' || (id.startsWith('binary:') && BIN.test(id.slice(7))))) {
      throw new AppError('PROBE_UNSUPPORTED', `unknown probe '${id}'. Built-ins: macos.xcode, binary:<name>`);
    }
  }
  const checkId = acquireCheckLease(ctx, row, 'capability', s);
  const started = Date.now();
  const os = row.observed_os ?? row.declared_os;
  const observations: Record<string, unknown>[] = [];
  let sshError: ReturnType<typeof classify> | null = null;
  for (const id of input.probe_ids) {
    const key = id === 'macos.xcode' ? 'macos.xcode' : `tool.${id.slice(7).toLowerCase()}`;
    let cmd: string;
    if (id === 'macos.xcode') {
      if (os !== 'macos' && os !== 'unknown') { observations.push({ probe_id: id, key, state: 'unavailable', details: `host OS is ${os}` }); continue; }
      cmd = 'xcodebuild -version 2>&1; echo "__rc=$?"';
    } else {
      const name = id.slice(7);
      // Non-login SSH PATH often misses Homebrew/Flutter/fvm: try PATH, then a login shell, then well-known dirs.
      cmd = os === 'windows' ? `cmd /c "where ${name} && echo __rc=0 || echo __rc=1"` : `v=path; p=$(command -v ${name} 2>/dev/null)
[ -z "$p" ] && v=login && p=$(zsh -lc 'command -v ${name}' 2>/dev/null || bash -lc 'command -v ${name}' 2>/dev/null)
[ -z "$p" ] && v=known_dir && for d in ${KNOWN_BIN_DIRS}; do [ -x "$d/${name}" ] && p="$d/${name}" && break; done
if [ -n "$p" ]; then echo "$p"; echo "__found_via=$v"; "$p" --version 2>&1 | head -n 3; echo "__rc=0"; else echo "__rc=1"; fi`;
    }
    const r = await sshRun(ctx, row, cmd, s.probe_timeout_s);
    const rc = /__rc=(\d+)/.exec(r.stdout)?.[1];
    if (rc === undefined) {
      if (r.exit_code === 255 || r.timed_out || r.spawn_error) { sshError = classify(r); break; }
      observations.push({ probe_id: id, key, state: 'unknown', details: 'probe output not understood (shell mismatch?)', diagnostics: diagnostics(r) });
      continue;
    }
    const via = /__found_via=(\w+)/.exec(r.stdout)?.[1];
    const text = sanitize(r.stdout.replace(/__rc=\d+\s*$/, '').replace(/__found_via=\w+\n?/, '').trim());
    const state = rc === '0' ? 'available' : 'unavailable';
    const path = text.split('\n')[0];
    observations.push({ probe_id: id, key, state, details: text.slice(0, 1000), ...(via ? { found_via: via, path } : {}),
      note: via && via !== 'path' ? `Not on the SSH PATH; call it as ${path} (or export PATH="${path.replace(/\/[^/]+$/, '')}:$PATH").` : 'Non-login SSH PATH may differ from an interactive terminal.' });
  }
  const t = now();
  const applied = finishCheck(ctx, row, checkId, started, sshError ? 'failure' : 'success', sshError?.code ?? null, { observations });
  if (applied) {
    tx(ctx.db, () => {
      const up = ctx.db.prepare('UPDATE capabilities SET last_observation_json=?, observed_at=?, probe_id=? WHERE host_id=? AND key=?');
      for (const o of observations) up.run(JSON.stringify({ state: o.state, details: o.details, evidence_check_id: checkId }), t, o.probe_id as string, row.id, o.key as string);
    });
  }
  return { success: !sshError, check_id: checkId, host_id: row.id, observed_at: t, observations, ...(sshError ? { error: sshError } : {}) };
}

// ---- remote folder listing (read-only; powers the SSH folder picker) ----

export async function listRemoteDir(ctx: Ctx, raw: unknown) {
  const input = z.object({ host_id: z.uuid(), path: z.string().max(4096).default('~') }).strict().parse(raw);
  const row = getHostRow(ctx.db, input.host_id);
  if ((row.observed_os ?? row.declared_os) === 'windows') throw new AppError('PROBE_UNSUPPORTED', 'folder browsing on Windows remote hosts is not supported in v1');
  const path = input.path.trim() || '~';
  if (!(path.startsWith('/') || path === '~' || path.startsWith('~/'))) throw new AppError('VALIDATION_ERROR', 'path must be absolute (/...) or start with ~');
  const assign = path === '~' ? 'P="$HOME"' : path.startsWith('~/') ? `P="$HOME"/${posixQuote(path.slice(2))}` : `P=${posixQuote(path)}`;
  const s = getSettings(ctx.db);
  const r = await sshRun(ctx, row, `${assign}
echo "@@HOME $HOME"
cd -- "$P" 2>/dev/null || { if [ -e "$P" ]; then echo "@@ERR inaccessible"; else echo "@@ERR missing"; fi; exit 0; }
echo "@@CWD $(pwd -P)"
ls . >/dev/null 2>&1 || { echo "@@ERR not_permitted"; exit 0; }
echo "@@LIST"
find . -mindepth 1 -maxdepth 1 -type d -exec sh -c 'for d; do n=\${d#./}; m=d; [ -e "$d/.git" ] && m=g; [ -f "$d/pubspec.yaml" ] || [ -f "$d/package.json" ] && m="\${m}p"; printf "%s %s\\0" "$m" "$n"; done' _ {} + 2>/dev/null | head -c 200000
echo; echo "@@END"`, s.check_timeout_s, { maxBytes: 256 << 10 });
  const out = r.stdout.replaceAll('\r\n', '\n');
  if (!out.includes('@@HOME')) {
    const c = classify(r);
    throw new AppError(c.code, c.message, { details: { host_id: row.id, diagnostics: diagnostics(r) }, next_action: c.next_action });
  }
  const home = /^@@HOME (.*)$/m.exec(out)?.[1] ?? '';
  const err = /^@@ERR (\w+)/m.exec(out)?.[1];
  if (err) {
    const tcc = (row.observed_os ?? row.declared_os) === 'macos' && /\/(Documents|Desktop|Downloads)(\/|$)|^~\/(Documents|Desktop|Downloads)/.test(path);
    return { host_id: row.id, path, home, error: err, entries: [],
      ...(tcc && err !== 'missing' ? { hint: 'macOS privacy blocks SSH from this folder. On the Mac enable System Settings → General → Sharing → Remote Login (i) → "Allow full disk access for remote users".' } : {}) };
  }
  const cwd = /^@@CWD (.*)$/m.exec(out)![1];
  const list = out.slice(out.indexOf('@@LIST\n') + 7, out.lastIndexOf('\n@@END'));
  const entries = list.split('\0').map((x) => x.replace(/^\n/, '')).filter((x) => x.includes(' ')).map((x) => {
    const sp = x.indexOf(' ');
    const m = x.slice(0, sp);
    return { name: x.slice(sp + 1), git: m.includes('g'), project_marker: m.includes('p') };
  }).filter((e) => e.name && !e.name.includes('\n')).sort((a, b) => Number(a.name.startsWith('.')) - Number(b.name.startsWith('.')) || a.name.localeCompare(b.name));
  return { host_id: row.id, path: cwd, home, parent: cwd === '/' ? null : cwd.replace(/\/[^/]+$/, '') || '/', entries, truncated: list.length >= 200000 };
}

// ---- recipe ----

export function connectionRecipe(ctx: Ctx, raw: unknown) {
  const input = z.object({ host_id: z.uuid(), caller_environment: z.enum(['windows-native', 'posix-native', 'wsl']), purpose: z.enum(['shell', 'file_transfer']).default('shell') }).strict().parse(raw);
  const env = executionEnvironment();
  if (input.caller_environment !== env) {
    throw new AppError('ENVIRONMENT_MISMATCH', `this manager runs ${env}; a recipe for ${input.caller_environment} would reference keys/config it cannot see`, {
      next_action: input.caller_environment === 'wsl' ? 'Run the agent shell in Windows (PowerShell) or deploy a separate manager inside WSL' : 'Call from the same environment the manager runs in',
    });
  }
  const host = getHost(ctx.db, input.host_id);
  const row = getHostRow(ctx.db, input.host_id);
  const p = profileOf(row);
  const s = getSettings(ctx.db);
  const quote = env === 'windows-native' ? psQuote : posixQuote;
  const base = sshBaseArgs(p, ctx.dataDir, s, input.purpose === 'file_transfer', row.id);
  const envPrefix = Object.entries(base.env).map(([k, v]) => (env === 'windows-native' ? `$env:${k}=${psQuote(v)}; ` : `${k}=${posixQuote(v)} `)).join('');
  const display = (argv: string[]) => envPrefix + (env === 'windows-native' ? '& ' : '') + argv.map(quote).join(' ');
  const authNote = p.auth === 'password'
    ? `Password auth: set the env vars in "env" for the ssh process. ssh then gets the password from the manager's askpass helper. The password is never shown to you; do not ask the user for it.${host.password_stored ? '' : ' NO PASSWORD IS STORED YET: ask the user to set it in the GUI.'}`
    : 'BatchMode=yes: no password prompts; use ssh-agent.';
  const meta = {
    host_id: row.id, host_revision: row.revision, identity_generation: row.identity_generation, environment: env, env: base.env, auth: p.auth ?? 'key',
    status: host.status, trust: host.trust, known_hosts: p.mode === 'direct' ? knownHostsPath(ctx.dataDir) : 'user-managed (ssh_config)',
    config_path: p.config_path ?? null, identity_file: p.mode === 'direct' ? p.identity_file ?? null : null,
    instructions_note: 'Host instructions and default_remote_directory are NOT injected; read them via get_host and decide yourself.',
  };
  if (input.purpose === 'shell') {
    const argv = [splitCommand(s.ssh_path).at(-1)!, ...base.args, '--', base.destination];
    return { ...meta, executable: argv[0], argv, shell: env === 'windows-native' ? 'powershell' : 'posix', display: display(argv),
      ...((row.observed_os ?? row.declared_os) === 'macos' ? { signing: signingRecipe(ctx, row) } : {}),
      notes: ['Append the remote command as the final argument (or omit for an interactive session if your terminal supports it).', authNote] };
  }
  const remoteHost = base.destination.includes(':') ? `[${base.destination}]` : base.destination;
  const scp = [splitCommand(s.scp_path).at(-1)!, ...base.args, '-r', '<local_path>', `${remoteHost}:<remote_path>`];
  return { ...meta, executable: scp[0], argv: scp, shell: env === 'windows-native' ? 'powershell' : 'posix', display: display(scp),
    sftp_argv: [splitCommand(s.sftp_path).at(-1)!, ...base.args, base.destination],
    notes: [authNote, 'scp/sftp use -P (capital) for port.', 'rsync is not assumed to exist on either side.', 'Replace <local_path>/<remote_path>; quote remote paths for the REMOTE shell.'] };
}
