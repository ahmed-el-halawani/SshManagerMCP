import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import type { Core } from '../src/core/index.ts';
import { cloneTo, git, key, makeCore, posixPath, tempRepo } from './helpers.ts';

before(() => { process.env.FAKE_SSH_MODE = 'sh'; });

type Pre = { verdict: string; facts: { kind: string; blocking: boolean; paths?: string[] }[]; source_snapshot: string; generations: { source: number; destination: number }; suggested_plan: { kind: string; copy?: string[] } };

function setup(srcDir: string, dstDir: string | null, core: Core = makeCore()) {
  const host = core.registerHost({ profile: { mode: 'direct', hostname: 'mac.lan', port: 22, username: 'dev' }, metadata: { name: 'mac', declared_os: 'linux' }, idempotency_key: key() }).host;
  const p = core.registerProject({ name: 'app', source_location: { host_id: null, path: srcDir }, idempotency_key: key() }).project;
  const loc = core.bindProjectLocation({ project_id: p.id, host_id: host.id, path: dstDir === null ? null : posixPath(dstDir), expected_project_revision: p.revision, idempotency_key: key() }).location;
  const pre = () => core.preflightProject({ project_id: p.id, destination_location_id: loc.id }) as Promise<Pre>;
  return { core, host, project: p, loc, pre };
}
const kinds = (r: Pre) => r.facts.filter((f) => f.blocking).map((f) => f.kind);

test('unset path stays unset; binding a missing path creates nothing', async () => {
  const src = tempRepo();
  const { pre, loc } = setup(src, null);
  assert.equal(loc.path_state, 'unset');
  assert.equal((await pre()).verdict, 'path_unset');
  const missing = join(mkdtempSync(join(tmpdir(), 'sshrm-x-')), 'not-here');
  const s2 = setup(src, missing);
  assert.equal((await s2.pre()).verdict, 'path_missing');
  assert.equal(existsSync(missing), false, 'no mkdir/clone during bind or inspect');
});

test('matching existing checkout is reused as ready; a new session rediscovers the same binding', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  const { core, pre, project, loc } = setup(src, dst);
  const r = await pre();
  assert.equal(r.verdict, 'ready', JSON.stringify(r.facts));
  assert.equal(core.getProject({ project_id: project.id }).locations.find((l) => l.id === loc.id)!.identity_state, 'verified');
  core.close();
  const fresh = makeCore('mcp', core.dataDir);
  const found = fresh.listProjects().projects;
  assert.equal(found.length, 1);
  assert.equal(found[0].locations.find((l) => l.id === loc.id)!.path_input, posixPath(dst));
});

test('same branch, different commit is not ready; plan moves commits without a cloud remote', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  writeFileSync(join(src, 'a.txt'), 'changed\n');
  git(src, 'commit', '-qam', 'second');
  const { pre } = setup(src, dst);
  const r = await pre();
  assert.equal(r.verdict, 'revision_mismatch');
  assert.ok(kinds(r).includes('content_mismatch'));
  assert.equal(r.suggested_plan.kind, 'incremental_transfer');
  assert.deepEqual(r.suggested_plan.copy, ['a.txt']);
});

test('same commit with different uncommitted files on destination is not ready and is protected', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  writeFileSync(join(dst, 'src', 'b.txt'), 'remote WIP\n');
  const r = await setup(src, dst).pre();
  assert.equal(r.verdict, 'destination_dirty');
  assert.equal(r.suggested_plan.kind, 'preserve_work');
  assert.ok(existsSync(join(dst, 'src', 'b.txt')));
});

test('different branch and detached HEAD give explicit states; nothing is switched', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  git(dst, 'switch', '-q', '-c', 'feature');
  const r = await setup(src, dst).pre();
  assert.equal(r.verdict, 'branch_mismatch');
  assert.equal(git(dst, 'branch', '--show-current'), 'feature');
  git(dst, 'checkout', '-q', '--detach');
  const d = await setup(src, dst).pre();
  assert.equal(d.verdict, 'branch_mismatch');
});

test('similar folder name is not identity: unrelated repo is wrong_repository', async () => {
  const src = tempRepo({ 'a.txt': 'hello\n' }, 'app');
  const other = tempRepo({ 'a.txt': 'hello\n', 'README': 'a different project\n' }, 'app');
  git(other, 'rm', '-q', 'README');
  git(other, 'commit', '-qm', 'same tree as source now, different history');
  const r = await setup(src, other).pre();
  assert.equal(r.verdict, 'wrong_repository');
  assert.equal(r.suggested_plan.kind, 'rebind');
});

test('editing the path invalidates verification and leaves the old folder alone', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  const { core, loc, project } = setup(src, dst);
  await core.inspectProject({ project_id: project.id });
  const before = core.getProject({ project_id: project.id }).locations.find((l) => l.id === loc.id)!;
  const other = cloneTo(src, 'other');
  const u = core.updateProjectLocation({ location_id: loc.id, expected_revision: before.revision, patch: { path: posixPath(other) }, idempotency_key: key() }) as { location: typeof before; note: string };
  assert.equal(u.location.location_generation, before.location_generation + 1);
  assert.equal(u.location.last_inspection, null);
  assert.equal(u.location.identity_state, 'unverified');
  assert.match(u.note, /No files were moved/);
  assert.ok(existsSync(join(dst, 'a.txt')));
});

test('agent transfer -> manager verifies; source change during transfer -> needs_recheck; stale deletions caught', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  writeFileSync(join(src, 'src', 'b.txt'), 'uncommitted source edit\n'); // source_snapshot mode: dirty source is fine
  writeFileSync(join(src, 'new.txt'), 'untracked but selected\n');
  const { core, pre, project, loc } = setup(src, dst);
  const r = await pre();
  assert.equal(r.verdict, 'content_mismatch');
  assert.deepEqual([...r.suggested_plan.copy!].sort(), ['new.txt', 'src/b.txt']);
  const lease = core.acquireLease({ location_id: loc.id, operation_id: 'op1', owner: 'agent-a' });
  assert.ok(lease);
  assert.throws(() => core.acquireLease({ location_id: loc.id, operation_id: 'op2', owner: 'agent-b' }), /holds/);

  // a claimed-but-not-done transfer is not verified
  const fake = await core.verifyProjectSync({ project_id: project.id, destination_location_id: loc.id, expected_source_snapshot: r.source_snapshot, operation_id: 'op1', expected_generations: r.generations }) as { outcome: string };
  assert.notEqual(fake.outcome, 'verified');

  for (const f of r.suggested_plan.copy!) copyFileSync(join(src, f), join(dst, f)); // "agent" does the transfer
  const v = await core.verifyProjectSync({ project_id: project.id, destination_location_id: loc.id, expected_source_snapshot: r.source_snapshot, operation_id: 'op1', expected_generations: r.generations }) as { outcome: string };
  assert.equal(v.outcome, 'verified');
  core.releaseLease({ location_id: loc.id, operation_id: 'op1', owner: 'agent-a' });
  assert.equal((await pre()).verdict, 'ready');

  // source changes after preflight: old snapshot cannot be verified
  writeFileSync(join(src, 'a.txt'), 'edited after preflight\n');
  const late = await core.verifyProjectSync({ project_id: project.id, destination_location_id: loc.id, expected_source_snapshot: r.source_snapshot, operation_id: 'op3', expected_generations: r.generations }) as { outcome: string };
  assert.equal(late.outcome, 'needs_recheck');

  // deleting a previously synced file in source must not leave a stale copy that looks ready
  writeFileSync(join(src, 'a.txt'), 'hello\n');
  rmSync(join(src, 'new.txt'));
  const stale = await pre();
  assert.equal(stale.verdict, 'content_mismatch');
  assert.ok(stale.facts.find((f) => f.kind === 'content_mismatch')!.paths!.includes('new.txt'));
});

test('nested/overlapping locations and home-root destinations are rejected before writes', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  const { core, project, host } = setup(src, dst);
  const p = core.getProject({ project_id: project.id });
  const nested = core.bindProjectLocation({ project_id: project.id, host_id: host.id, path: posixPath(join(dst, 'src')), expected_project_revision: p.revision, idempotency_key: key() }).location;
  await core.inspectProject({ project_id: project.id });
  const r = await core.preflightProject({ project_id: project.id, destination_location_id: nested.id }) as Pre;
  assert.ok(r.facts.some((f) => f.kind === 'unsupported_layout'), JSON.stringify(r.facts));
  const p2 = core.getProject({ project_id: project.id });
  const home = core.bindProjectLocation({ project_id: project.id, host_id: host.id, path: '~', expected_project_revision: p2.revision, idempotency_key: key() }).location;
  const h = await core.preflightProject({ project_id: project.id, destination_location_id: home.id }) as Pre;
  assert.ok(h.facts.some((f) => f.kind === 'unsupported_layout' && /root/.test(JSON.stringify(f))), JSON.stringify(h.facts));
});

test('Git source vs plain-copy destination: tracked build/ files are out of scope, not a blocker', async () => {
  const src = tempRepo({ 'lib/a.dart': 'main(){}\n', 'android/build/report.html': '<p>x</p>\n' });
  const dst = join(mkdtempSync(join(tmpdir(), 'sshrm-copy-')), 'app');
  mkdirSync(join(dst, 'lib'), { recursive: true });
  writeFileSync(join(dst, 'lib', 'a.dart'), 'main(){}\n');
  const r = await setup(src, dst).pre();
  assert.equal(r.verdict, 'ready', JSON.stringify(r.facts));
  assert.ok(r.facts.some((f) => f.kind === 'scope_difference' && !f.blocking && f.paths?.includes('android/build/report.html')));
});

test('same commit checked out with CRLF (Windows autocrlf) vs LF is ready via Git blob ids', async () => {
  const src = tempRepo({ 'a.txt': 'line1\nline2\n', 'lib/b.dart': 'void main() {}\n' });
  const dst = join(mkdtempSync(join(tmpdir(), 'sshrm-crlf-')), 'clone');
  git(dirname(dst), 'clone', '-q', src, dst); // helper clones with autocrlf=false: LF bytes
  const crlf = join(mkdtempSync(join(tmpdir(), 'sshrm-crlf-')), 'win');
  const r = spawnSync('git', ['-c', 'core.autocrlf=true', 'clone', '-q', src, crlf], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  spawnSync('git', ['config', 'core.autocrlf', 'true'], { cwd: crlf });
  assert.ok(readFileSync(join(crlf, 'a.txt'), 'utf8').includes('\r\n'), 'fixture must have CRLF bytes');
  const pre = await setup(crlf, dst).pre();
  assert.equal(pre.verdict, 'ready', JSON.stringify(pre.facts));
  assert.ok(pre.facts.some((f) => f.kind === 'filter_only_differences' && !f.blocking));
});

test('find on host: matches by folder and package name, ranks same Git repo first, rejects other repos', async () => {
  const src = tempRepo({ 'pubspec.yaml': 'name: coach_app\r\n', 'lib/a.dart': 'x\n' }, 'coach_app');
  const base = mkdtempSync(join(tmpdir(), 'sshrm-home-'));
  const clone = cloneTo(src, 'coach_app'); // same repo, same folder name
  const renamed = join(base, 'work', 'renamed-copy'); // different folder name, same package name, no git
  mkdirSync(renamed, { recursive: true });
  writeFileSync(join(renamed, 'pubspec.yaml'), 'name: coach_app\n');
  const other = tempRepo({ 'README': 'other\n' }, 'coach_app'); // same folder name, different repo
  const { core, host, project } = setup(src, null);
  for (const root of [dirname(clone), base, dirname(other)]) {
    const r = await core.findProjectOnHost({ host_id: host.id, project_id: project.id, search_root: posixPath(root), max_depth: 3 }) as any;
    assert.ok(r.candidates.length >= 1, JSON.stringify(r));
    const c = r.candidates[0];
    if (root === dirname(clone)) assert.equal(c.same_repository, true);
    if (root === base) { assert.deepEqual(c.matched_by, ['package_name']); assert.equal(c.same_repository, null); }
    if (root === dirname(other)) assert.equal(c.same_repository, false);
  }
});

test('non-Git project uses a manifest; caches and credentials excluded on both sides', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sshrm-plain-'));
  const src = join(base, 'src'); const dst = join(base, "dst with space & 'quote'");
  for (const d of [src, dst]) {
    mkdirSync(join(d, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(d, 'main.c'), 'int main(){}\n');
    writeFileSync(join(d, 'node_modules', 'x', 'i.js'), d === src ? 'a' : 'b');
    writeFileSync(join(d, '.env'), d === src ? 'SECRET=1' : 'SECRET=2');
  }
  const { pre } = setup(src, dst);
  const r = await pre();
  assert.equal(r.verdict, 'ready', JSON.stringify(r.facts));
  writeFileSync(join(dst, 'main.c'), 'int main(){return 1;}\n');
  assert.equal((await pre()).verdict, 'content_mismatch');
});
