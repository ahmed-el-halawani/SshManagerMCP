// Creates a sandbox data dir whose "remote host" is the fake ssh from the tests (remote scripts run in local Git-Bash sh).
// usage: node scripts/bench-setup.ts <data dir>   -> prints the host id
import { resolve } from 'node:path';
import { createCore } from '../src/core/index.ts';

const core = createCore({ source: 'gui', dataDir: process.argv[2] });
core.setSettings({ ssh_path: JSON.stringify([process.execPath, resolve('tests/fixtures/fake-ssh.mjs')]) });
const h = core.registerHost({ profile: { mode: 'direct', hostname: '10.9.9.9', port: 22, username: 'dev' },
  metadata: { name: 'bench-linux', declared_os: 'linux' }, idempotency_key: `bench-${Date.now()}` }).host;
console.log(h.id);
core.close();
