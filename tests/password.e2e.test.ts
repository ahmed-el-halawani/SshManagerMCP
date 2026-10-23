// Opt-in: real Windows OpenSSH against a real password-only sshd.
//   docker run -d -p 127.0.0.1:2222:2222 -e PASSWORD_ACCESS=true -e USER_NAME=tester -e USER_PASSWORD=... lscr.io/linuxserver/openssh-server
//   SSHRM_E2E_PASSWORD_FILE=<file with that password> npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCore } from '../src/core/index.ts';
import { key } from './helpers.ts';

const pwFile = process.env.SSHRM_E2E_PASSWORD_FILE;

test('password auth end-to-end: trust, wrong/missing password, check, probe, agent recipe', { skip: !pwFile && 'set SSHRM_E2E_PASSWORD_FILE' }, async () => {
  const password = readFileSync(pwFile!, 'utf8');
  const dataDir = mkdtempSync(join(tmpdir(), 'sshrm-e2e-'));
  const core = createCore({ dataDir, source: 'gui' });
  const host = core.registerHost({ profile: { mode: 'direct', hostname: '127.0.0.1', port: 2222, username: 'tester', auth: 'password' },
    metadata: { name: 'docker sshd', declared_os: 'linux' }, idempotency_key: key() }).host;

  // 1. unknown host key: never auto-trusted, even with password auth
  let r = await core.checkHost({ host_id: host.id }) as any;
  assert.equal(r.error.code, 'TRUST_REQUIRED');
  const cand = r.trust_candidates.find((c: any) => c.algorithm === 'ED25519') ?? r.trust_candidates[0];
  await core.approveHostKey({ host_id: host.id, fingerprint: cand.fingerprint, algorithm: cand.algorithm, expected_identity_generation: host.identity_generation });

  // 2. no stored password -> AUTH_REQUIRED without hanging
  r = await core.checkHost({ host_id: host.id });
  assert.equal(r.error.code, 'AUTH_REQUIRED');

  // 3. wrong password -> AUTH_REQUIRED, bounded
  core.setHostPassword({ host_id: host.id, password: 'definitely-wrong' });
  const t0 = Date.now();
  r = await core.checkHost({ host_id: host.id });
  assert.equal(r.error.code, 'AUTH_REQUIRED', JSON.stringify(r.error));
  assert.ok(Date.now() - t0 < 20_000);

  // 4. right password -> reachable; secret never stored in plaintext
  core.setHostPassword({ host_id: host.id, password });
  r = await core.checkHost({ host_id: host.id });
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.equal(r.observed_os, 'linux');
  const dump = JSON.stringify(core.db.prepare('SELECT * FROM host_secrets').all()) + JSON.stringify(core.db.prepare('SELECT * FROM checks').all())
    + JSON.stringify(core.getHost({ host_id: host.id })) + readFileSync(join(dataDir, 'askpass.mjs'), 'utf8');
  assert.ok(!dump.includes(password), 'plaintext password leaked');
  assert.equal(core.getHost({ host_id: host.id }).password_stored, true);

  const probe = await core.probeCapabilities({ host_id: host.id, probe_ids: ['binary:sh'] }) as any;
  assert.equal(probe.observations[0].state, 'available');

  // 5. agent path: run the recipe exactly as an agent terminal would (argv + env), unknown command
  const recipe = core.connectionRecipe({ host_id: host.id, caller_environment: 'windows-native' }) as any;
  assert.ok(!JSON.stringify(recipe).includes(password));
  const out = spawnSync(recipe.argv[0], [...recipe.argv.slice(1), 'echo hello-from-$(whoami); uname -s'], { env: { ...process.env, ...recipe.env }, encoding: 'utf8', timeout: 20_000 });
  assert.match(out.stdout, /hello-from-tester\s+Linux/, out.stderr);

  // 6. endpoint change deletes the stored password (never sent to a different target)
  const cur = core.getHost({ host_id: host.id });
  core.updateHost({ host_id: host.id, expected_revision: cur.revision, patch: { profile: { mode: 'direct', hostname: '127.0.0.2', port: 2222, username: 'tester', auth: 'password' } }, idempotency_key: key() });
  assert.equal(core.getHost({ host_id: host.id }).password_stored, false);
  core.close();
});
