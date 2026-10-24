/**
 * macOS code signing over SSH, without anyone at the Mac.
 *
 * macOS unlocks a keychain only for the security session that ran the unlock, and every SSH
 * connection is a new session. So the unlock has to happen inside the same SSH session as the
 * build. The runner (src/cli/run.ts) opens that session, sends the keychain password as the first
 * stdin line, and the remote wrapper hands it to `security` through the printf builtin: it never
 * appears in argv, env, logs or tool output. Then the agent's command runs with signing available.
 *
 * Modes, chosen by the user per host:
 *  - login_keychain: unlocks the login keychain with the stored host password (= Mac login password).
 *  - build_keychain: a separate keychain holding only code-signing identities, with its own random
 *    password. Set up once automatically (the identity is copied from the login keychain using the
 *    stored host password); after that the login password is never used for builds.
 * Honest limit: as with the askpass helper, any process running as this Windows user can decrypt
 * the stored secrets (DPAPI CurrentUser).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sshRun, type Ctx } from './checks.ts';
import { now, tx } from './db.ts';
import { AppError } from './errors.ts';
import { audit, getHostRow, profileOf, type HostRow } from './hosts.ts';
import { getSecret, hasSecret, putSecret } from './secrets.ts';
import { getSettings } from './settings.ts';
import { posixQuote, psQuote, sanitize, splitCommand, sshArgs } from './ssh.ts';

export type SigningMode = HostRow['signing_mode'];
const LOGIN = '$HOME/Library/Keychains/login.keychain-db';
const BUILD = '$HOME/Library/Keychains/sshrm-signing.keychain-db';
export const RUNNER = fileURLToPath(new URL(`../cli/run${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

/** Remote exit codes of the wrapper itself (the agent's command never ran). */
export const WRAPPER_EXIT = { no_secret: 97, unlock_failed: 98, build_keychain_missing: 96 } as const;

function assertMac(row: HostRow) {
  const os = row.observed_os ?? row.declared_os;
  if (os !== 'macos') throw new AppError('PROBE_UNSUPPORTED', `code signing unlock is for macOS hosts; this host is ${os}. Run a host check first if it really is a Mac.`);
}

/** The agent's command, wrapped so this SSH session unlocks the keychain first (secret = first stdin line). */
export function signedRemoteCommand(mode: Exclude<SigningMode, 'off'>, command: string) {
  const kc = mode === 'login_keychain' ? LOGIN : BUILD;
  const script = [
    `K="${kc}"`,
    mode === 'build_keychain' ? `[ -f "$K" ] || { echo 'sshrm: the build keychain is missing on this Mac' >&2; exit ${WRAPPER_EXIT.build_keychain_missing}; }` : '',
    `IFS= read -r P || { echo 'sshrm: no keychain password on stdin' >&2; exit ${WRAPPER_EXIT.no_secret}; }`,
    `printf '%s\\n' "$P" | security unlock-keychain "$K" >/dev/null 2>&1 || { P=; echo 'sshrm: unlocking ${mode === 'login_keychain' ? 'the login keychain failed: is the stored host password still the Mac login password?' : 'the build keychain failed: run its setup again'}' >&2; exit ${WRAPPER_EXIT.unlock_failed}; }`,
    'P=',
    // codesign takes the first keychain in the search list that has the identity: keep ours first
    mode === 'build_keychain' ? `security list-keychains -d user | head -n 1 | grep -q sshrm-signing || security list-keychains -d user -s "$K" $(security list-keychains -d user | tr -d '"' | grep -v sshrm-signing)` : '',
    `echo 'sshrm: keychain unlocked for this SSH session (${mode})' >&2`,
    'exec "${SHELL:-/bin/sh}" -lc "$1"',
  ].filter(Boolean).join('\n');
  return `/bin/sh -c ${posixQuote(script)} sshrm ${posixQuote(command)}`;
}

/**
 * One-time setup of mode B. Stdin lines: login password, new build keychain password, .p12 as base64, .p12 password.
 * Without a .p12 the identity is exported from the login keychain; macOS refuses that for keys whose access control
 * requires a click ("User interaction is not allowed"), and then the user provides a .p12 once in the GUI.
 */
const SETUP_SCRIPT = `L="${LOGIN}"; K="${BUILD}"
IFS= read -r LP; IFS= read -r BP; IFS= read -r PB; IFS= read -r TP
T=$(mktemp -d) || exit 10; chmod 700 "$T"; trap 'rm -rf "$T"' EXIT
# ponytail: the p12 password is on argv of \`security import\` for a moment (no stdin option); the file is in a 700 temp dir, deleted on exit
if [ -n "$PB" ]; then
  printf '%s' "$PB" | base64 -D > "$T/id.p12" 2>/dev/null || { echo "@@ERR p12_decode"; exit 17; }
  PB=
else
  printf '%s\\n' "$LP" | security unlock-keychain "$L" >/dev/null 2>&1 || { echo "@@ERR login_unlock: the stored host password did not unlock the login keychain"; exit 11; }
  TP=$(LC_ALL=C tr -dc A-Za-z0-9 </dev/urandom | head -c 32)
  security export -k "$L" -t identities -f pkcs12 -P "$TP" -o "$T/id.p12" >/dev/null 2>"$T/err" || { echo "@@ERR export: $(head -c 300 "$T/err")"; exit 12; }
fi
LP=
[ -f "$K" ] && security delete-keychain "$K"
printf '%s\\n%s\\n' "$BP" "$BP" | security create-keychain "$K" >/dev/null 2>&1 || { echo "@@ERR create_keychain"; exit 13; }
security set-keychain-settings "$K"
printf '%s\\n' "$BP" | security unlock-keychain "$K" >/dev/null 2>&1 || { echo "@@ERR unlock_new"; exit 14; }
security import "$T/id.p12" -k "$K" -P "$TP" -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>"$T/err" || { echo "@@ERR import: $(head -c 300 "$T/err")"; exit 15; }
printf '%s\\n' "$BP" | security set-key-partition-list -S apple-tool:,apple:,codesign: -s "$K" >/dev/null 2>&1 || { echo "@@ERR partition_list"; exit 16; }
BP=
security find-identity -v "$K" | awk '/\\)/{print $2}' | sort > "$T/all"
security find-identity -v -p codesigning "$K" | awk '/\\)/{print $2}' | sort > "$T/cs"
comm -23 "$T/all" "$T/cs" | while read -r h; do security delete-identity -Z "$h" "$K" >/dev/null 2>&1; done
security list-keychains -d user -s "$K" $(security list-keychains -d user | tr -d '"' | grep -v sshrm-signing)
echo "@@IDS"; security find-identity -v -p codesigning "$K"; echo "@@OK"`;

/** `p12` is GUI-only (main process reads the file): the MCP tool schema has just host_id. */
export async function setupBuildKeychain(ctx: Ctx, raw: unknown) {
  const input = z.object({ host_id: z.uuid(), p12: z.object({ base64: z.string().min(16).max(1 << 20).regex(/^[A-Za-z0-9+/=]+$/), password: z.string().max(1024).regex(/^[^\r\n\0]*$/) }).optional() }).strict().parse(raw);
  const row = getHostRow(ctx.db, input.host_id);
  assertMac(row);
  if (row.signing_mode !== 'build_keychain') throw new AppError('VALIDATION_ERROR', 'this host is not set to the build keychain signing mode; the user chooses that in the GUI host page');
  const login = input.p12 ? '' : getSecret(ctx.db, row.id, 'password');
  if (login === null) throw new AppError('AUTH_REQUIRED', 'setup copies the signing identity from the login keychain and needs the stored host password; set it in the GUI, or import a .p12 there');
  const bp = randomBytes(24).toString('base64url');
  const r = await sshRun(ctx, row, SETUP_SCRIPT, 180, { input: `${login}\n${bp}\n${input.p12?.base64 ?? ''}\n${input.p12?.password ?? ''}\n` });
  if (!r.stdout.includes('@@OK')) {
    const step = /^@@ERR (.*)$/m.exec(r.stdout)?.[1] ?? `exit ${r.exit_code}: ${r.stderr.slice(0, 300)}`;
    const blocked = /User interaction is not allowed/.test(step);
    tx(ctx.db, () => ctx.db.prepare('UPDATE hosts SET signing_state_json=? WHERE id=?').run(JSON.stringify({ needs_p12: blocked, last_error: sanitize(step).slice(0, 300), at: now() }), row.id));
    throw new AppError(blocked ? 'AUTH_REQUIRED' : 'REMOTE_COMMAND_FAILED', blocked
      ? 'macOS does not allow copying this signing key without a click on the Mac. The user must export it once as a .p12 (Keychain Access → My Certificates → Export) and import it on this host page; or use login keychain mode.'
      : `build keychain setup failed at ${sanitize(step)}`, { details: { host_id: row.id, step: sanitize(step).slice(0, 200) } });
  }
  const identities = r.stdout.split('@@IDS')[1].split('\n').flatMap((l) => { const m = /\d+\) ([0-9A-F]{40}) "(.+)"/.exec(l); return m ? [{ sha1: m[1], name: m[2] }] : []; });
  if (!identities.length) throw new AppError('REMOTE_COMMAND_FAILED', 'the login keychain has no valid code-signing identity to copy (sign in to Xcode with your Apple ID first)');
  const state = { keychain: '~/Library/Keychains/sshrm-signing.keychain-db', identities, set_up_at: now() };
  putSecret(ctx.db, row.id, 'build_keychain', bp);
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE hosts SET signing_state_json=? WHERE id=?').run(JSON.stringify(state), row.id);
    audit(ctx.db, ctx.source, 'setup_build_keychain', row.id, null, null, { identities: identities.map((i) => i.name) });
  });
  return { host_id: row.id, ...state, note: 'Build keychain ready: no auto-lock, only code-signing identities. Builds unlock it per SSH session; the login password is no longer used. Re-run after renewing your certificate.' };
}

/** GUI only: the user decides whether the manager may unlock a keychain on their Mac. */
export function setSigningMode(ctx: Ctx, raw: unknown) {
  const input = z.object({ host_id: z.uuid(), mode: z.enum(['off', 'login_keychain', 'build_keychain']) }).strict().parse(raw);
  const row = getHostRow(ctx.db, input.host_id);
  if (input.mode !== 'off') assertMac(row);
  if (input.mode === 'login_keychain' && !hasSecret(ctx.db, row.id, 'password')) throw new AppError('AUTH_REQUIRED', 'login keychain mode uses the stored host password; set it first');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE hosts SET signing_mode=? WHERE id=?').run(input.mode, row.id);
    if (input.mode !== 'build_keychain') {
      ctx.db.prepare("DELETE FROM host_secrets WHERE host_id=? AND kind='build_keychain'").run(row.id);
      ctx.db.prepare('UPDATE hosts SET signing_state_json=NULL WHERE id=?').run(row.id);
    }
    audit(ctx.db, ctx.source, 'set_signing_mode', row.id, null, null, { mode: input.mode });
  });
  return { host_id: row.id, mode: input.mode, needs_setup: input.mode === 'build_keychain' && !hasSecret(ctx.db, row.id, 'build_keychain') };
}

/** What the runner spawns. The secret goes only into `stdin`; the caller writes it to the ssh child and closes it. */
export async function prepareSignedRun(ctx: Ctx, input: { host_id: string; command: string }) {
  const row = getHostRow(ctx.db, input.host_id);
  if (row.signing_mode === 'off') throw new AppError('VALIDATION_ERROR', 'code signing unlock is off for this host; the user can turn it on in the GUI host page');
  assertMac(row);
  if (row.signing_mode === 'build_keychain' && !hasSecret(ctx.db, row.id, 'build_keychain')) await setupBuildKeychain(ctx, { host_id: row.id });
  const secret = getSecret(ctx.db, row.id, row.signing_mode === 'login_keychain' ? 'password' : 'build_keychain');
  if (!secret) throw new AppError('AUTH_REQUIRED', 'no stored secret for this signing mode');
  const s = getSettings(ctx.db);
  const { args, env } = sshArgs(profileOf(row), ctx.dataDir, s, signedRemoteCommand(row.signing_mode, input.command), row.id);
  return { mode: row.signing_mode, command: splitCommand(s.ssh_path), args, env, stdin: `${secret}\n` };
}

/**
 * Bounded signing readiness, three separate stages, because a found certificate alone proved nothing in the
 * failures we saw: (1) identity discovery, (2) keychain unlock in an SSH session, (3) actually signing a throwaway file.
 */
export async function checkSigning(ctx: Ctx, raw: unknown) {
  const input = z.object({ host_id: z.uuid() }).strict().parse(raw);
  const row = getHostRow(ctx.db, input.host_id);
  assertMac(row);
  const checked_at = now();
  const found = await sshRun(ctx, row, 'security find-identity -v -p codesigning', 30);
  if (found.exit_code === 255 || found.timed_out) return { host_id: row.id, checked_at, mode: row.signing_mode, ready: false, stage: 'connection', detail: sanitize(found.stderr).slice(0, 300) };
  const identities = found.stdout.split('\n').flatMap((l) => { const m = /\d+\) ([0-9A-F]{40}) "(.+)"/.exec(l); return m ? [{ sha1: m[1], name: m[2] }] : []; });
  if (!identities.length) return { host_id: row.id, checked_at, mode: row.signing_mode, ready: false, stage: 'certificate', certificates: [], detail: 'no valid code-signing identity in the keychain search list (sign in to Xcode with the Apple ID / download certificates)' };
  const probe = `f=$(mktemp /tmp/sshrm-sign.XXXXXX) || exit 9; printf x > "$f"; codesign -f -s ${identities[0].sha1} "$f" 2>&1; echo "@@RC $?"; rm -f "$f"`;
  let r;
  if (row.signing_mode === 'off') r = await sshRun(ctx, row, probe, 60);
  else {
    if (row.signing_mode === 'build_keychain' && !hasSecret(ctx.db, row.id, 'build_keychain')) {
      return { host_id: row.id, checked_at, mode: row.signing_mode, ready: false, stage: 'unlock', certificates: identities, detail: 'the build keychain is not set up yet (ssh_hosts_setup_build_keychain, or the runner does it on first use)' };
    }
    const secret = getSecret(ctx.db, row.id, row.signing_mode === 'login_keychain' ? 'password' : 'build_keychain');
    r = await sshRun(ctx, row, signedRemoteCommand(row.signing_mode, probe), 60, { input: `${secret ?? ''}\n` });
  }
  const unlock = row.signing_mode === 'off' ? 'not_attempted' : Object.values(WRAPPER_EXIT).includes(r.exit_code as 96) ? 'failed' : 'ok';
  const rc = /@@RC (\d+)/.exec(r.stdout)?.[1];
  const signed = rc === '0';
  return {
    host_id: row.id, checked_at, mode: row.signing_mode, ready: signed && row.signing_mode !== 'off', certificates: identities,
    stages: { certificate: 'ok', unlock, key_access: rc === undefined ? 'not_checked' : signed ? 'ok' : 'failed' },
    detail: signed ? (row.signing_mode === 'off' ? 'Signing works in a plain SSH session right now (keychain already unlocked), but nothing keeps it so: choose a signing mode.' : 'A test file was signed inside an unlocked SSH session: device builds can sign.')
      : sanitize(`${r.stdout.replace(/@@RC \d+/, '')} ${r.stderr}`).trim().slice(0, 300) || `exit ${r.exit_code}`,
  };
}

export const COMMAND_ENV = 'SSHRM_REMOTE_COMMAND';

/**
 * Windows: the app exe is a GUI-subsystem program, so PowerShell returns from it at once, with no output and
 * no exit code, while the job keeps running. A batch file does wait for it and returns its exit code.
 * The remote command travels in an env var: cmd re-parses & | > " in arguments, never in env values.
 */
export function writeRunnerShim(dataDir: string) {
  const shim = join(dataDir, 'sshrm-run.cmd');
  writeFileSync(shim, `@echo off\r\nrem generated by SSH Resource Manager: waits for the signing runner and returns its exit code\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${RUNNER}" "--data-dir=${dataDir}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  return shim;
}

/** The `signing` block of a shell recipe: how an agent runs a command with signing unlocked. */
export function signingRecipe(ctx: Ctx, row: HostRow) {
  if (row.signing_mode === 'off') return { mode: 'off', note: 'Keychain unlock is off. Device builds will fail with errSecInternalComponent over SSH; the user can choose a signing mode on the host page.' };
  const common = 'It opens its own SSH session, unlocks the keychain inside it, then runs the command in a login shell; it waits until the command ends and passes through its output and exit code. ' +
    'The secret is never shown to you. Exit 96/97/98 = the unlock failed (your command did not run); 3 = manager error (JSON on stderr). Stdin is not forwarded. Check readiness first with ssh_hosts_check_signing.';
  if (process.platform === 'win32') {
    const shim = join(ctx.dataDir, 'sshrm-run.cmd');
    return {
      mode: row.signing_mode, argv: [shim, `--host=${row.id}`], command_env: COMMAND_ENV,
      display: `$env:${COMMAND_ENV} = '<remote command>'; & ${psQuote(shim)} --host=${row.id}; $LASTEXITCODE`,
      note: `For anything that code-signs (flutter build ios / run --release, xcodebuild for a device): put the remote command in env ${COMMAND_ENV}, then run argv (a .cmd launcher). Do not call the app .exe directly: it returns immediately. ${common}`,
    };
  }
  return { mode: row.signing_mode, argv: [process.execPath, RUNNER, `--data-dir=${ctx.dataDir}`, `--host=${row.id}`, '--'], env: { ELECTRON_RUN_AS_NODE: '1' },
    note: `Run argv + ONE final argument, the remote command (or set ${COMMAND_ENV}). ${common}` };
}
