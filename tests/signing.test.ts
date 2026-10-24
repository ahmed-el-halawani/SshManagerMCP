import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { before, test } from 'node:test';
import { putSecret } from '../src/core/secrets.ts';
import { RUNNER } from '../src/core/signing.ts';
import { key, makeCore } from './helpers.ts';

// A fake macOS `security`: unlock-keychain reads the password from stdin and logs what it got.
const fakeBin = mkdtempSync(join(tmpdir(), 'sshrm-sec-'));
const secLog = join(fakeBin, 'security.log');
writeFileSync(join(fakeBin, 'security'), `#!/bin/sh
case "$1" in
  unlock-keychain) IFS= read -r pw; echo "unlock $2 $pw" >> "$FAKE_SEC_LOG"; [ "$pw" = "$FAKE_SEC_PW" ] || exit 51; : > "$FAKE_UNLOCKED" ;;
  find-identity) echo '  1) E09C03E09DFA812540D8F3498F288B22DD494356 "Apple Development: Test (ABC)"'; echo '     1 valid identities found' ;;
  list-keychains) [ "$4" = "-s" ] && echo "set-search $5" >> "$FAKE_SEC_LOG" || echo '    "'"$HOME"'/Library/Keychains/login.keychain-db"' ;;
esac
`);
// A fake codesign that, like the real one over SSH, can use the key only after this session unlocked the keychain.
writeFileSync(join(fakeBin, 'codesign'), `#!/bin/sh
[ -f "$FAKE_UNLOCKED" ] && { rm -f "$FAKE_UNLOCKED"; exit 0; }
echo "$5: errSecInternalComponent"; exit 1
`);
const home = mkdtempSync(join(tmpdir(), 'sshrm-home-'));
const fakeEnv = () => ({ PATH: fakeBin + delimiter + process.env.PATH, HOME: home, FAKE_SEC_LOG: secLog, FAKE_UNLOCKED: join(fakeBin, 'unlocked') });

before(() => { process.env.FAKE_SSH_MODE = 'sh'; });

function macHost(password = 'pw-secret') {
  const core = makeCore('gui');
  const host = core.registerHost({ profile: { mode: 'direct', hostname: 'mac.lan', port: 22, username: 'dev', auth: 'password' }, metadata: { name: 'mac', declared_os: 'macos' }, idempotency_key: key() }).host;
  core.setHostPassword({ host_id: host.id, password });
  return { core, host };
}

/** Runs exactly what the recipe says: the .cmd launcher, with the remote command in its env var. */
function runner(core: ReturnType<typeof makeCore>, hostId: string, command: string, macPassword: string) {
  const recipe = core.connectionRecipe({ host_id: hostId, caller_environment: 'windows-native' }) as { signing: { mode: string; argv: string[]; command_env: string } };
  const argsFile = join(fakeBin, `args-${key()}.json`);
  writeFileSync(secLog, '');
  const [shim, ...args] = recipe.signing.argv;
  assert.match(shim, /\.cmd$/);
  const r = spawnSync('cmd.exe', ['/d', '/c', shim, ...args], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ...fakeEnv(), [recipe.signing.command_env]: command, FAKE_SEC_PW: macPassword, FAKE_SSH_ARGS_FILE: argsFile } });
  return { ...r, sshArgs: readFileSync(argsFile, 'utf8'), log: readFileSync(secLog, 'utf8') };
}

test('login keychain mode: the build runs in the same session after an unlock fed through stdin only', () => {
  const { core, host } = macHost();
  assert.equal(core.connectionRecipe({ host_id: host.id, caller_environment: 'windows-native' }).signing.mode, 'off');
  core.setSigningMode({ host_id: host.id, mode: 'login_keychain' });
  const r = runner(core, host.id, 'echo "BUILD & RAN" | cat; exit 7', 'pw-secret'); // cmd metacharacters + a real exit code
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stdout, /BUILD & RAN/);
  assert.match(r.log, /^unlock .*login\.keychain-db pw-secret$/m);
  assert.ok(!r.sshArgs.includes('pw-secret'), 'the secret must not be on the ssh command line');
  assert.ok(!r.stdout.includes('pw-secret') && !r.stderr.includes('pw-secret'));
});

test('a failed unlock stops before the command runs (exit 98)', () => {
  const { core, host } = macHost('not-the-mac-password');
  core.setSigningMode({ host_id: host.id, mode: 'login_keychain' });
  const r = runner(core, host.id, 'echo BUILD_RAN', 'pw-secret');
  assert.equal(r.status, 98);
  assert.doesNotMatch(r.stdout, /BUILD_RAN/);
  assert.match(r.stderr, /login keychain failed/);
});

test('build keychain mode unlocks only the build keychain and puts it first in the search list', () => {
  const { core, host } = macHost();
  core.setSigningMode({ host_id: host.id, mode: 'build_keychain' });
  putSecret(core.db, host.id, 'build_keychain', 'random-build-pw'); // what setup stores
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
  writeFileSync(join(home, 'Library', 'Keychains', 'sshrm-signing.keychain-db'), '');
  const r = runner(core, host.id, 'echo BUILD_RAN', 'random-build-pw');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BUILD_RAN/);
  assert.match(r.log, /^unlock .*sshrm-signing\.keychain-db random-build-pw$/m);
  assert.match(r.log, /^set-search .*sshrm-signing/m);
  assert.doesNotMatch(r.log, /pw-secret/, 'the login password is not used once the build keychain exists');
});

test('the recipe runner path exists (it is part of the build, not just src)', () => {
  const { core, host } = macHost();
  core.setSigningMode({ host_id: host.id, mode: 'login_keychain' });
  const shim = core.connectionRecipe({ host_id: host.id, caller_environment: 'windows-native' }).signing.argv[0];
  assert.ok(existsSync(shim), shim);
  assert.ok(existsSync(RUNNER), RUNNER);
  assert.ok(existsSync(join(import.meta.dirname, '..', 'dist', 'cli', 'run.js')), 'npm run build must emit dist/cli/run.js');
});

test('signing check separates certificate, unlock and key access (a found certificate alone is not ready)', async () => {
  const { core, host } = macHost();
  const saved = { ...process.env };
  Object.assign(process.env, fakeEnv(), { FAKE_SEC_PW: 'pw-secret' }); // checkSigning runs ssh in-process
  rmSync(fakeEnv().FAKE_UNLOCKED, { force: true }); // every SSH session starts locked
  try {
    const off = await core.checkSigning({ host_id: host.id }) as any;
    assert.deepEqual(off.stages, { certificate: 'ok', unlock: 'not_attempted', key_access: 'failed' });
    assert.equal(off.ready, false);
    assert.match(off.detail, /errSecInternalComponent/);
    core.setSigningMode({ host_id: host.id, mode: 'login_keychain' });
    const on = await core.checkSigning({ host_id: host.id }) as any;
    assert.deepEqual(on.stages, { certificate: 'ok', unlock: 'ok', key_access: 'ok' });
    assert.equal(on.ready, true);
    assert.ok(on.checked_at);
    process.env.FAKE_SEC_PW = 'changed-on-the-mac';
    const bad = await core.checkSigning({ host_id: host.id }) as any;
    assert.equal(bad.stages.unlock, 'failed');
    assert.equal(bad.ready, false);
  } finally { process.env = saved; }
});

test('signing modes are guarded: macOS only, off by default, mode change drops the build keychain secret', () => {
  const { core, host } = macHost();
  core.setSigningMode({ host_id: host.id, mode: 'build_keychain' });
  putSecret(core.db, host.id, 'build_keychain', 'x');
  core.setSigningMode({ host_id: host.id, mode: 'login_keychain' });
  assert.equal(core.getHost({ host_id: host.id }).signing.build_keychain_secret_stored, false);
  assert.equal(core.getHost({ host_id: host.id }).password_stored, true, 'the host password is kept');
  const linux = core.registerHost({ profile: { mode: 'direct', hostname: 'l.lan', port: 22, username: 'dev' }, metadata: { name: 'linux', declared_os: 'linux' }, idempotency_key: key() }).host;
  assert.throws(() => core.setSigningMode({ host_id: linux.id, mode: 'login_keychain' }), /macOS/);
  assert.rejects(core.setupBuildKeychain({ host_id: host.id }), /not set to the build keychain/);
});
