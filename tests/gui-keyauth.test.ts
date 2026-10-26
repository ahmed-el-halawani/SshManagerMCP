import assert from 'node:assert/strict';
import { test } from 'node:test';

// The GUI's check helper with the IPC bridge and localStorage stubbed: no Electron needed.
const calls: string[] = [];
let host = { auth: 'password', password_stored: true, profile: { mode: 'direct' }, identity_generation: 1 };
let check = { success: true, observed_os: 'macos' };
let switchFails = false;
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  window: { api: { call: async (method: string) => {
    calls.push(method);
    if (method === 'checkHost') return { ok: true, result: check };
    if (method === 'getHost') return { ok: true, result: host };
    if (method === 'switchToKeyAuth') return switchFails ? { ok: false, error: { code: 'AUTH_REQUIRED', message: 'key-only login failed' } } : { ok: true, result: { note: 'Key auth is on.' } };
    throw new Error(method);
  } } },
});
const { checkHost } = await import('../src/renderer/api.ts');
const switches = () => calls.filter((c) => c === 'switchToKeyAuth').length;

test('GUI check: first success on a password host switches to a key once; never on failure, key hosts or Windows', async () => {
  check = { success: false, observed_os: 'macos' };
  await checkHost('h1');
  assert.equal(switches(), 0, 'a failed check never switches');

  check = { success: true, observed_os: 'windows' };
  await checkHost('h1');
  assert.equal(switches(), 0, 'Windows hosts are not supported by the switch');

  check = { success: true, observed_os: 'macos' };
  assert.equal((await checkHost('h1')).key_auth, 'Key auth is on.');
  await checkHost('h1');
  assert.equal(switches(), 1, 'only once per host account');

  switchFails = true;
  const r = await checkHost('h2');
  assert.match(r.key_auth, /Stayed on password login: AUTH_REQUIRED/);
  await checkHost('h2');
  assert.equal(switches(), 2, 'a refused switch is not retried on every check');

  host = { ...host, identity_generation: 2 };
  await checkHost('h2');
  assert.equal(switches(), 3, 'a new account (identity change) gets one fresh try');

  host = { ...host, auth: 'key', identity_generation: 3 };
  await checkHost('h3');
  assert.equal(switches(), 3, 'key hosts are left alone');
});
