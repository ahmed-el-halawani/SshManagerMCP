import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConnectionInput } from '../src/core/parse.ts';

test('accepts supported simple invocations', () => {
  const r = parseConnectionInput('ssh -p 2222 -i "C:\\Users\\me\\.ssh\\id ed" dev@mac.local', 'powershell');
  assert.ok(r.ok, r.errors.join());
  assert.deepEqual(r.draft, { mode: 'direct', hostname: 'mac.local', port: 2222, username: 'dev', identity_file: 'C:\\Users\\me\\.ssh\\id ed', identities_only: true });

  const v6 = parseConnectionInput("ssh 'dev'@[fe80::1] -p22", 'posix');
  assert.equal(v6.draft?.hostname, 'fe80::1');
  assert.equal(v6.draft?.port, 22);

  const alias = parseConnectionInput('ssh macmini', 'cmd');
  assert.equal(alias.draft?.mode, 'ssh_alias');
  assert.ok(alias.warnings.length);

  const noUser = parseConnectionInput('ssh 192.168.1.20', 'posix');
  assert.deepEqual(noUser.missing_fields, ['username']);
  assert.equal(noUser.ok, false);

  assert.equal(parseConnectionInput(`ssh -l 'dev.user' "h.lan"`, 'powershell').draft?.username, 'dev.user');
  assert.equal(parseConnectionInput(`ssh -l "dev.user" h.lan`, 'cmd').draft?.username, 'dev.user');
  const q = parseConnectionInput(`ssh -l 'o''brien' h.lan`, 'powershell');
  assert.equal(q.ok, false);
  assert.match(q.errors.join(), /username/);
});

test('rejects anything executable or unsupported, without running it', () => {
  const bad: [string, 'posix' | 'powershell' | 'cmd'][] = [
    ['ssh dev@h uptime', 'posix'],
    ['ssh dev@h; rm -rf /', 'posix'],
    ['ssh dev@h | tee x', 'powershell'],
    ['ssh $(whoami)@h', 'posix'],
    ['ssh "dev$HOME"@h', 'posix'],
    ['ssh -o ProxyCommand="nc %h %p" dev@h', 'posix'],
    ['ssh -o LocalCommand=calc dev@h', 'posix'],
    ['ssh `id`@h', 'posix'],
    ['ssh dev@h & calc', 'cmd'],
    ['ssh %USERNAME%@h', 'cmd'],
    ['ssh -X dev@h', 'posix'],
    ['ssh dev@h:2222', 'posix'],
    ['ssh -- -oProxyCommand=x', 'posix'],
    ["ssh 'unterminated", 'posix'],
  ];
  for (const [text, shell] of bad) {
    const r = parseConnectionInput(text, shell);
    assert.equal(r.ok, false, text);
    assert.ok(r.errors.length > 0 || r.draft === null, text);
  }
});
