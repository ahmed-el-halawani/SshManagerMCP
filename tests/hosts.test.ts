import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb, SCHEMA_VERSION } from '../src/core/db.ts';
import { AppError } from '../src/core/errors.ts';
import { directHost, key, makeCore } from './helpers.ts';

const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

test('GUI and MCP see each other\'s writes through the same DB; restart keeps records', () => {
  const gui = makeCore('gui');
  const mcp = makeCore('mcp', gui.dataDir);
  const h = directHost(gui);
  assert.equal(mcp.getHost({ host_id: h.id }).name, 'mac-mini');
  const h2 = directHost(mcp, { name: 'linux-box' });
  assert.ok(gui.listHosts().hosts.some((x) => x.id === h2.id));
  gui.close(); mcp.close();
  const again = makeCore('gui', gui.dataDir);
  assert.equal(again.listHosts().hosts.length, 2);
});

test('idempotent register: same key returns same host, changed input conflicts', () => {
  const core = makeCore();
  const input = { profile: { mode: 'direct', hostname: 'h.lan', port: 22, username: 'u' }, metadata: { name: 'x' }, idempotency_key: key() };
  const a = core.registerHost(input);
  const b = core.registerHost(input);
  assert.equal(a.host.id, b.host.id);
  assert.equal(b.replayed, true);
  assert.equal(core.listHosts().hosts.length, 1);
  assert.equal(code(() => core.registerHost({ ...input, metadata: { name: 'y' } })), 'IDEMPOTENCY_CONFLICT');
  // duplicate target warns, does not merge
  const c = core.registerHost({ ...input, idempotency_key: key() });
  assert.notEqual(c.host.id, a.host.id);
  assert.equal(c.duplicate_candidates[0].id, a.host.id);
});

test('concurrent edits: second writer gets REVISION_CONFLICT, first edit survives', () => {
  const gui = makeCore('gui');
  const mcp = makeCore('mcp', gui.dataDir);
  const h = directHost(gui);
  gui.updateHost({ host_id: h.id, expected_revision: 1, patch: { metadata: { instructions: 'use ~/work' } }, idempotency_key: key() });
  assert.equal(code(() => mcp.updateHost({ host_id: h.id, expected_revision: 1, patch: { metadata: { description: 'x' } }, idempotency_key: key() })), 'REVISION_CONFLICT');
  assert.equal(mcp.getHost({ host_id: h.id }).instructions, 'use ~/work');
});

test('capability update keeps instructions; unknown keys allowed; declared != observed', () => {
  const core = makeCore();
  const h = core.registerHost({ profile: { mode: 'ssh_alias', alias: 'macmini' }, metadata: { name: 'm', instructions: 'keep me' },
    capabilities: [{ key: 'macos.xcode', label: 'Xcode' }, { key: 'device.iphone' }, { key: 'something.custom' }], idempotency_key: key() }).host;
  const u = core.updateHost({ host_id: h.id, expected_revision: 1, patch: { capabilities: { upsert: [{ key: 'tool.flutter' }], remove: ['something.custom'] } }, idempotency_key: key() }).host;
  assert.equal(u.instructions, 'keep me');
  assert.deepEqual(u.capabilities.map((c) => c.key), ['device.iphone', 'macos.xcode', 'tool.flutter']);
  assert.equal(u.capabilities[0].observation, null);
});

test('offline host is saved with metadata and gets a classified error, not invented data', async () => {
  const core = makeCore();
  const h = directHost(core, { description: 'Mac in office', instructions: 'Xcode 16' });
  for (const [mode, expected, state] of [['dns', 'DNS_FAILED', 'unreachable'], ['auth', 'AUTH_REQUIRED', 'auth_required'], ['trust', 'TRUST_REQUIRED', 'trust_required'], ['changed', 'HOST_KEY_CHANGED', 'host_key_changed']] as const) {
    process.env.FAKE_SSH_MODE = mode;
    const r = await core.checkHost({ host_id: h.id }) as { success: boolean; error: { code: string } };
    assert.equal(r.success, false);
    assert.equal(r.error.code, expected, mode);
    const g = core.getHost({ host_id: h.id });
    assert.equal(g.status.state, state);
    assert.equal(g.observed_os, null);
    assert.equal(g.description, 'Mac in office');
  }
});

test('Windows remote: failed POSIX bootstrap falls back to cmd, not auth error', async () => {
  const core = makeCore();
  const h = directHost(core, { declared_os: 'macos' });
  process.env.FAKE_SSH_MODE = 'windows';
  const r = await core.checkHost({ host_id: h.id }) as { success: boolean; observed_os: string; os_mismatch: boolean };
  assert.equal(r.success, true);
  assert.equal(r.observed_os, 'windows');
  assert.equal(r.os_mismatch, true);
  const g = core.getHost({ host_id: h.id });
  assert.equal(g.declared_os, 'macos', 'user statement kept as-is');
  assert.equal(g.os_mismatch, true);
});

test('check that started before an endpoint change does not mark the new endpoint reachable', async () => {
  const core = makeCore();
  const h = directHost(core);
  process.env.FAKE_SSH_MODE = 'slow-ok';
  process.env.FAKE_SSH_DELAY = '1500';
  const pending = core.checkHost({ host_id: h.id });
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(core.checkHost({ host_id: h.id }), (e: AppError) => e.code === 'CHECK_IN_PROGRESS');
  core.updateHost({ host_id: h.id, expected_revision: 1, patch: { profile: { mode: 'direct', hostname: '10.0.0.99', port: 22, username: 'dev', identities_only: false } }, idempotency_key: key() });
  const r = await pending as { success: boolean; applied_to_current_profile: boolean };
  assert.equal(r.success, true);
  assert.equal(r.applied_to_current_profile, false);
  assert.equal(core.getHost({ host_id: h.id }).status.state, 'unchecked');
  assert.equal(core.hostHistory({ host_id: h.id }).checks.length, 1, 'kept as history');
});

test('host removed mid-check is not recreated', async () => {
  const core = makeCore();
  const h = directHost(core);
  process.env.FAKE_SSH_MODE = 'slow-ok';
  process.env.FAKE_SSH_DELAY = '800';
  const pending = core.checkHost({ host_id: h.id });
  await new Promise((r) => setTimeout(r, 200));
  core.removeHost({ host_id: h.id, expected_revision: 1 });
  await pending;
  assert.equal(core.listHosts().hosts.length, 0);
});

test('hung ssh is killed within the bound and leaves no process; output flood is truncated', async () => {
  const core = makeCore();
  core.setSettings({ check_timeout_s: 5 });
  const h = directHost(core);
  process.env.FAKE_SSH_MODE = 'hang';
  const t0 = Date.now();
  const r = await core.checkHost({ host_id: h.id }) as { success: boolean; error: { code: string } };
  const elapsed = Date.now() - t0;
  assert.equal(r.error.code, 'CONNECTION_TIMEOUT');
  assert.ok(elapsed < 2 * 5 * 1000 + 3000, `bounded (${elapsed}ms)`); // posix + windows attempts at most
  const procs = spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*fake-ssh.mjs*' } | Measure-Object | % Count"], { encoding: 'utf8' });
  assert.equal(procs.stdout.trim(), '0', 'no fake ssh left running');

  process.env.FAKE_SSH_MODE = 'flood';
  const f = await core.checkHost({ host_id: h.id }) as { success: boolean; error: { code: string; diagnostics: { stdout_truncated: boolean } } };
  assert.equal(f.success, false);
  assert.equal(f.error.diagnostics.stdout_truncated, true);
});

test('no secrets in DB/log/output; BatchMode and strict host key checking always on', async () => {
  const core = makeCore();
  const h = core.registerHost({ profile: { mode: 'direct', hostname: 'h.lan', port: 2200, username: 'dev', identity_file: 'C:\\keys\\id ed25519', identities_only: true },
    metadata: { name: 'k' }, idempotency_key: key() }).host;
  const argsFile = join(mkdtempSync(join(tmpdir(), 'sshrm-args-')), 'a.json');
  process.env.FAKE_SSH_MODE = 'auth';
  process.env.FAKE_SSH_ARGS_FILE = argsFile;
  await core.checkHost({ host_id: h.id });
  delete process.env.FAKE_SSH_ARGS_FILE;
  const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
  assert.ok(args.includes('BatchMode=yes') && args.includes('StrictHostKeyChecking=yes'));
  assert.ok(!args.some((a) => /StrictHostKeyChecking=(no|accept-new)/.test(a)));
  assert.equal(args[args.indexOf('-i') + 1], 'C:\\keys\\id ed25519', 'path with space stays one argv element');
  assert.ok(args.some((a) => a.startsWith('UserKnownHostsFile="')));
  assert.equal(args[args.indexOf('-p') + 1], '2200');
  // strict schema has nowhere to put secrets
  assert.throws(() => core.registerHost({ profile: { mode: 'direct', hostname: 'h', username: 'u', password: 'hunter2' }, metadata: { name: 'p' }, idempotency_key: key() }), /password|Unrecognized/);
  const dump = JSON.stringify(core.db.prepare('SELECT * FROM hosts').all()) + JSON.stringify(core.db.prepare('SELECT * FROM checks').all());
  assert.ok(!dump.includes('hunter2'));
});

test('password auth: DPAPI-encrypted at rest, askpass answers only password prompts, argv switches auth mode', async () => {
  const core = makeCore('gui');
  const h = core.registerHost({ profile: { mode: 'direct', hostname: 'h.lan', port: 22, username: 'dev', auth: 'password' }, metadata: { name: 'pw' }, idempotency_key: key() }).host;
  const secret = `p@ss & 'quote' %PATH% ${Date.now()}`;
  core.setHostPassword({ host_id: h.id, password: secret });
  const blob = (core.db.prepare('SELECT secret_blob FROM host_secrets').get() as { secret_blob: string }).secret_blob;
  assert.ok(!blob.includes(secret) && blob.length > 100);
  assert.ok(!JSON.stringify(core.getHost({ host_id: h.id })).includes(secret));

  // the .cmd shim itself is exercised by ssh in password.e2e.test.ts
  const askpass = (prompt: string) => spawnSync(process.execPath, [join(core.dataDir, 'askpass.mjs'), prompt], { env: { ...process.env, SSHRM_HOST_ID: h.id }, encoding: 'utf8' });
  assert.equal(askpass("dev@h.lan's password: ").stdout, secret + '\n');
  assert.equal(askpass('Enter passphrase for key id_rsa:').stdout, '');
  assert.equal(askpass('Are you sure you want to continue connecting (yes/no)?').stdout, '');

  const argsFile = join(mkdtempSync(join(tmpdir(), 'sshrm-args-')), 'a.json');
  process.env.FAKE_SSH_MODE = 'auth';
  process.env.FAKE_SSH_ARGS_FILE = argsFile;
  await core.checkHost({ host_id: h.id });
  delete process.env.FAKE_SSH_ARGS_FILE;
  const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
  assert.ok(args.includes('BatchMode=no') && args.includes('PubkeyAuthentication=no') && args.includes('StrictHostKeyChecking=yes'));
  assert.ok(!args.join(' ').includes(secret));
  const recipe = core.connectionRecipe({ host_id: h.id, caller_environment: 'windows-native' }) as { env: Record<string, string>; display: string };
  assert.equal(recipe.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.ok(!JSON.stringify(recipe).includes(secret));
  assert.match(recipe.display, /^\$env:SSH_ASKPASS=/);
});

test('recipe: environment mismatch is refused; recipe is argv with scp -P', () => {
  const core = makeCore();
  const h = core.registerHost({ profile: { mode: 'direct', hostname: 'fe80::1', port: 2222, username: 'dev' }, metadata: { name: 'v6' }, idempotency_key: key() }).host;
  assert.equal(code(() => core.connectionRecipe({ host_id: h.id, caller_environment: 'wsl' })), 'ENVIRONMENT_MISMATCH');
  const r = core.connectionRecipe({ host_id: h.id, caller_environment: 'windows-native', purpose: 'file_transfer' }) as { argv: string[] };
  assert.ok(r.argv.includes('-P') && r.argv.includes('2222'));
  assert.ok(r.argv.at(-1)!.startsWith('[fe80::1]:'));
  const s = core.connectionRecipe({ host_id: h.id, caller_environment: 'windows-native' }) as { argv: string[]; display: string };
  assert.equal(s.argv.at(-1), 'fe80::1');
  assert.ok(s.display.startsWith('& '));
});

test('schema: newer DB refused; v1-only DB upgrades without losing hosts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sshrm-mig-'));
  const v1 = openDb(dir, 'registry.db', 1);
  v1.prepare("INSERT INTO hosts(id,name,connection_mode,connection_profile_json,created_at,updated_at) VALUES('11111111-1111-4111-8111-111111111111','old','ssh_alias','{\"mode\":\"ssh_alias\",\"alias\":\"old\"}','t','t')").run();
  v1.close();
  const up = openDb(dir);
  assert.equal((up.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.equal((up.prepare('SELECT count(*) n FROM hosts').get() as { n: number }).n, 1);
  up.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  up.close();
  assert.throws(() => openDb(dir), (e: AppError) => e.code === 'SCHEMA_TOO_NEW');
  new DatabaseSync(join(dir, 'registry.db')).close();
});
