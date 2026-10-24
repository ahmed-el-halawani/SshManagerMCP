import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { before, test } from 'node:test';
import { putSecret } from '../src/core/secrets.ts';
import { key, makeCore } from './helpers.ts';

// A fake macOS `security`: unlock-keychain reads the password from stdin and logs what it got.
const fakeBin = mkdtempSync(join(tmpdir(), 'sshrm-sec-'));
const secLog = join(fakeBin, 'security.log');
writeFileSync(join(fakeBin, 'security'), `#!/bin/sh
case "$1" in
  unlock-keychain) IFS= read -r pw; echo "unlock $2 $pw" >> "$FAKE_SEC_LOG"; [ "$pw" = "$FAKE_SEC_PW" ] || exit 51 ;;
  list-keychains) [ "$4" = "-s" ] && echo "set-search $5" >> "$FAKE_SEC_LOG" || echo '    "'"$HOME"'/Library/Keychains/login.keychain-db"' ;;
esac
`);
const home = mkdtempSync(join(tmpdir(), 'sshrm-home-'));

before(() => { process.env.FAKE_SSH_MODE = 'sh'; });

function macHost(password = 'pw-secret') {
  const core = makeCore('gui');
  const host = core.registerHost({ profile: { mode: 'direct', hostname: 'mac.lan', port: 22, username: 'dev', auth: 'password' }, metadata: { name: 'mac', declared_os: 'macos' }, idempotency_key: key() }).host;
  core.setHostPassword({ host_id: host.id, password });
  return { core, host };
}

function runner(core: ReturnType<typeof makeCore>, hostId: string, command: string, macPassword: string) {
  const recipe = core.connectionRecipe({ host_id: hostId, caller_environment: 'windows-native' }) as { signing: { mode: string; argv: string[]; env: Record<string, string> } };
  const argsFile = join(fakeBin, `args-${key()}.json`);
  writeFileSync(secLog, '');
  const [exe, ...args] = recipe.signing.argv;
  const r = spawnSync(exe, [...args, command], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ...recipe.signing.env, PATH: fakeBin + delimiter + process.env.PATH, HOME: home, FAKE_SEC_LOG: secLog, FAKE_SEC_PW: macPassword, FAKE_SSH_ARGS_FILE: argsFile } });
  return { ...r, sshArgs: readFileSync(argsFile, 'utf8'), log: readFileSync(secLog, 'utf8') };
}

test('login keychain mode: the build runs in the same session after an unlock fed through stdin only', () => {
  const { core, host } = macHost();
  assert.equal(core.connectionRecipe({ host_id: host.id, caller_environment: 'windows-native' }).signing.mode, 'off');
  core.setSigningMode({ host_id: host.id, mode: 'login_keychain' });
  const r = runner(core, host.id, 'echo BUILD_RAN', 'pw-secret');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BUILD_RAN/);
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
  const runner = core.connectionRecipe({ host_id: host.id, caller_environment: 'windows-native' }).signing.argv[1];
  assert.ok(existsSync(runner), runner);
  assert.ok(existsSync(join(import.meta.dirname, '..', 'dist', 'cli', 'run.js')), 'npm run build must emit dist/cli/run.js');
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
