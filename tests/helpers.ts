import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore, type Core } from '../src/core/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_SSH = JSON.stringify([process.execPath, resolve(here, 'fixtures', 'fake-ssh.mjs')]);

export function makeCore(source: 'gui' | 'mcp' = 'mcp', dataDir = mkdtempSync(join(tmpdir(), 'sshrm-'))): Core {
  const core = createCore({ dataDir, source });
  core.setSettings({ ssh_path: FAKE_SSH, check_timeout_s: 5, connect_timeout_s: 2, probe_timeout_s: 5, inspect_timeout_s: 30 });
  return core;
}

let n = 0;
export const key = () => `test-key-${Date.now()}-${n++}`;

export const directHost = (core: Core, extra: Record<string, unknown> = {}) => core.registerHost({
  profile: { mode: 'direct', hostname: '10.0.0.5', port: 22, username: 'dev' },
  metadata: { name: 'mac-mini', declared_os: 'linux', description: 'build box', ...extra }, idempotency_key: key(),
}).host;

export function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function tempRepo(files: Record<string, string> = { 'a.txt': 'hello\n', 'src/b.txt': 'bee\n' }, name = 'repo') {
  const dir = join(mkdtempSync(join(tmpdir(), 'sshrm-src-')), name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function cloneTo(src: string, name = 'clone') {
  const dir = join(mkdtempSync(join(tmpdir(), 'sshrm-dst-')), name);
  git(dirname(dir), 'clone', '-q', src, dir);
  return dir;
}

/** C:\x\y -> /c/x/y, how Git-Bash (our fake remote) sees it. */
export const posixPath = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replaceAll('\\', '/');
