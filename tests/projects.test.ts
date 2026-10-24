import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import type { Core } from '../src/core/index.ts';
import { evaluateToolchain, projectRequirements, satisfies } from '../src/core/toolchain.ts';
import { cloneTo, git, key, makeCore, posixPath, tempRepo } from './helpers.ts';

before(() => { process.env.FAKE_SSH_MODE = 'sh'; });

type Pre = { verdict: string; facts: { kind: string; blocking: boolean; paths?: string[] }[]; source_snapshot: string; generations: { source: number; destination: number }; suggested_plan: { kind: string; copy?: string[] };
  summary: { setup: string | null; readiness: Record<string, string>; since_verified_sync: { local_only: number; remote_only: number; both: number } | null } };
type Verify = { outcome: string };

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
  assert.throws(() => core.bindProjectLocation({ project_id: project.id, host_id: host.id, path: posixPath(join(dst, 'src')), expected_project_revision: p.revision, idempotency_key: key() }), /overlaps/);
  assert.throws(() => core.bindProjectLocation({ project_id: project.id, host_id: host.id, path: posixPath(dst) + '/', expected_project_revision: p.revision, idempotency_key: key() }), /same folder/);
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

/** The "agent" copies the planned files, then the manager verifies. */
async function syncOnce(core: Core, project: { id: string }, loc: { id: string }, src: string, dst: string, pre: () => Promise<Pre>, only?: number) {
  const r = await pre();
  for (const f of (r.suggested_plan.copy ?? []).slice(0, only)) { mkdirSync(dirname(join(dst, f)), { recursive: true }); copyFileSync(join(src, f), join(dst, f)); }
  return { r, v: await core.verifyProjectSync({ project_id: project.id, destination_location_id: loc.id, expected_source_snapshot: r.source_snapshot, operation_id: key(), expected_generations: r.generations }) as Verify };
}

test('independent working setups: two local copies on different branches sync to their own folders on one host', async () => {
  const main = tempRepo();
  const learning = cloneTo(main, 'learning');
  git(learning, 'switch', '-q', '-c', 'learning');
  writeFileSync(join(learning, 'a.txt'), 'learning edit\n');
  git(learning, 'commit', '-qam', 'learning');
  const macMain = cloneTo(main, 'mac-main');
  const macLearning = cloneTo(learning, 'mac-learning');
  const { core, project, host, loc, pre } = setup(main, macMain);
  const p = core.getProject({ project_id: project.id });
  const exp = core.bindProjectLocation({ project_id: project.id, host_id: host.id, path: posixPath(macLearning), label: 'learning', source_path: learning,
    expected_project_revision: p.revision, idempotency_key: key() }).location;
  assert.equal(core.getProject({ project_id: project.id }).source_location_id, p.source_location_id, 'the existing source is not changed');
  assert.notEqual(exp.source_location_id, p.source_location_id);
  const preExp = () => core.preflightProject({ project_id: project.id, destination_location_id: exp.id }) as Promise<Pre>;
  assert.equal((await pre()).verdict, 'ready');
  const e = await preExp();
  assert.equal(e.verdict, 'ready', JSON.stringify(e.facts));
  assert.equal(e.summary.setup, 'learning');

  writeFileSync(join(learning, 'src', 'b.txt'), 'experiment wip\n');
  const { r, v } = await syncOnce(core, project, exp, learning, macLearning, preExp);
  assert.deepEqual(r.suggested_plan.copy, ['src/b.txt']);
  assert.equal(v.outcome, 'verified');
  assert.equal(readFileSync(join(macMain, 'src', 'b.txt'), 'utf8'), 'bee\n', 'the other setup is untouched');
  assert.equal((await pre()).verdict, 'ready');

  const rev = () => core.getProject({ project_id: project.id }).revision;
  assert.throws(() => core.bindProjectLocation({ project_id: project.id, host_id: host.id, path: posixPath(join(macLearning, 'lib')), source_path: learning, expected_project_revision: rev(), idempotency_key: key() }), /overlaps/);
  const locRev = () => core.getProject({ project_id: project.id }).locations.find((l) => l.id === exp.id)!.revision;
  assert.throws(() => core.updateProjectLocation({ location_id: exp.id, expected_revision: locRev(), patch: { path: posixPath(macMain) }, idempotency_key: key() }), /same folder/);
  // removing the setup removes its own source record too; the primary mapping stays
  core.unbindProjectLocation({ location_id: exp.id, expected_revision: locRev() });
  assert.deepEqual(core.getProject({ project_id: project.id }).locations.map((l) => l.id).sort(), [p.source_location_id, loc.id].sort());
});

test('after a verified sync, later local edits are not destination work; destination edits are protected', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  writeFileSync(join(src, 'a.txt'), 'first edit\n');
  const { core, pre, project, loc } = setup(src, dst);
  assert.equal((await syncOnce(core, project, loc, src, dst, pre)).v.outcome, 'verified'); // a.txt is now uncommitted on the destination

  writeFileSync(join(src, 'a.txt'), 'second edit\n');
  const local = await pre();
  assert.equal(local.verdict, 'content_mismatch', JSON.stringify(local.facts));
  assert.deepEqual(local.summary.since_verified_sync, { local_only: 1, remote_only: 0, both: 0 });
  assert.equal((await syncOnce(core, project, loc, src, dst, pre)).v.outcome, 'verified');

  writeFileSync(join(dst, 'src', 'b.txt'), 'edited on the mac\n'); // e.g. pub get rewrote a lockfile there
  const remote = await pre();
  assert.equal(remote.verdict, 'destination_dirty');
  assert.deepEqual(remote.summary.since_verified_sync, { local_only: 0, remote_only: 1, both: 0 });
  writeFileSync(join(src, 'src', 'b.txt'), 'edited on the pc\n');
  const both = await pre();
  assert.equal(both.verdict, 'destination_dirty');
  assert.equal(both.summary.since_verified_sync!.both, 1);
  assert.equal(readFileSync(join(dst, 'src', 'b.txt'), 'utf8'), 'edited on the mac\n');
});

test('a commit made on the destination is destination_ahead (not dirty); basis "destination" runs that checkout as it is', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  writeFileSync(join(src, 'a.txt'), 'synced edit\n');
  const { core, pre, project, loc } = setup(src, dst);
  assert.equal((await syncOnce(core, project, loc, src, dst, pre)).v.outcome, 'verified');
  writeFileSync(join(dst, 'src', 'b.txt'), 'team setting changed on the mac\n');
  git(dst, 'commit', '-qam', 'mac-only commit'); // like the Xcode team commit: working tree clean afterwards
  const r = await pre() as Pre & { execution: { verdict: string; commit: string } };
  assert.equal(r.verdict, 'destination_ahead', JSON.stringify(r.facts));
  assert.ok(!r.facts.some((f) => f.kind === 'destination_dirty'));
  assert.equal(r.suggested_plan.kind, 'preserve_commits');

  const asIs = await core.preflightProject({ project_id: project.id, destination_location_id: loc.id, basis: 'destination' }) as typeof r & { ready_for_intent: boolean };
  assert.equal(asIs.verdict, 'destination_ahead', 'the sync verdict is unchanged');
  assert.equal(asIs.execution.verdict, 'ready');
  assert.equal(asIs.ready_for_intent, true);
  assert.equal(asIs.execution.commit, git(dst, 'rev-parse', 'HEAD'));

  writeFileSync(join(dst, 'src', 'b.txt'), 'and an uncommitted edit\n');
  assert.equal((await pre()).verdict, 'destination_dirty');
});

test('summary output caps path lists per fact; detail "full" keeps them', async () => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, `v${i}\n`]));
  const src = tempRepo(files);
  const dst = cloneTo(src);
  for (const f of Object.keys(files)) writeFileSync(join(src, f), 'changed\n');
  const { core, pre, project, loc } = setup(src, dst);
  const s = (await pre()).facts.find((f) => f.kind === 'content_mismatch') as { paths: string[]; paths_total?: number };
  assert.equal(s.paths.length, 5);
  assert.equal(s.paths_total, 12);
  const full = await core.preflightProject({ project_id: project.id, destination_location_id: loc.id, detail: 'full' }) as Pre & { source?: unknown };
  assert.equal(full.facts.find((f) => f.kind === 'content_mismatch')!.paths!.length, 12);
  assert.ok(full.source, 'raw inspections only in full');
  assert.equal((await pre()).suggested_plan.copy!.length, 12, 'the copy list is never shortened');
});

test('recovery: interrupted transfer is partial, retry verifies; destination edited after preflight; expired lease', async () => {
  const src = tempRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  const dst = cloneTo(src);
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(src, f), `${f} v2\n`);
  const { core, pre, project, loc } = setup(src, dst);
  core.acquireLease({ location_id: loc.id, operation_id: 'op1', owner: 'agent-a', ttl_seconds: 10 });
  assert.ok((await pre()).facts.some((f) => f.kind === 'lease_held'));

  const cut = await syncOnce(core, project, loc, src, dst, pre, 1); // connection dropped after one file
  assert.equal(cut.v.outcome, 'partial');
  assert.equal((await syncOnce(core, project, loc, src, dst, pre)).v.outcome, 'verified'); // retry copies the rest

  writeFileSync(join(src, 'a.txt'), 'a v3\n');
  const r = await pre();
  copyFileSync(join(src, 'a.txt'), join(dst, 'a.txt'));
  writeFileSync(join(dst, 'a.txt'), 'changed by someone else after the copy\n');
  const v = await core.verifyProjectSync({ project_id: project.id, destination_location_id: loc.id, expected_source_snapshot: r.source_snapshot, operation_id: 'op1', expected_generations: r.generations }) as Verify;
  assert.notEqual(v.outcome, 'verified');

  assert.throws(() => core.acquireLease({ location_id: loc.id, operation_id: 'op2', owner: 'agent-b' }), /holds/);
  core.db.prepare('UPDATE project_operation_leases SET expires_at=?').run(new Date(Date.now() - 1000).toISOString());
  assert.ok(core.acquireLease({ location_id: loc.id, operation_id: 'op2', owner: 'agent-b' }), 'an expired lease does not block');
});

test('project in a repo subfolder: clean files use index blob ids, an uncommitted edit is still seen', async () => {
  const repo = tempRepo({ 'README': 'root\n', 'app/lib/a.dart': 'v1\n', 'app/pubspec.yaml': 'name: app\n' });
  const clone = cloneTo(repo);
  const { pre } = setup(join(repo, 'app'), join(clone, 'app'));
  assert.equal((await pre()).verdict, 'ready');
  writeFileSync(join(clone, 'app', 'lib', 'a.dart'), 'edited on the mac, not committed\n');
  const r = await pre();
  assert.equal(r.verdict, 'destination_dirty', JSON.stringify(r.facts));
  assert.deepEqual(r.facts.find((f) => f.kind === 'destination_dirty')!.paths, ['lib/a.dart']);
});

test('toolchain: pubspec constraints, fvm pin and SDK versions on both sides (read-only)', () => {
  assert.ok(satisfies('3.5.4', '>=3.4.0 <4.0.0'));
  assert.ok(!satisfies('3.3.9', '>=3.4.0 <4.0.0'));
  assert.ok(satisfies('3.7.0', '^3.5.0') && !satisfies('4.0.0', '^3.5.0') && !satisfies('0.3.0', '^0.2.1'));
  assert.ok(satisfies('3.11.0-200.0.dev', '>=3.10.0 <4.0.0'));
  const dir = mkdtempSync(join(tmpdir(), 'sshrm-pub-'));
  writeFileSync(join(dir, 'pubspec.yaml'), 'name: app\r\nenvironment:\r\n  sdk: ">=3.10.0 <4.0.0"\r\n  flutter: ">=3.40.0"\r\ndependencies:\r\n  flutter:\r\n    sdk: flutter\r\n');
  const req = projectRequirements(dir)!;
  assert.deepEqual(req, { uses_flutter: true, dart: '>=3.10.0 <4.0.0', flutter: '>=3.40.0' });
  const pc = { flutter: '3.44.8', dart: '3.10.4' };
  assert.equal(evaluateToolchain(req, pc, { flutter: '3.47.7', dart: '3.11.0' }).state, 'differs');
  assert.equal(evaluateToolchain(req, pc, { ...pc }).state, 'ok');
  assert.equal(evaluateToolchain(req, pc, { flutter: '3.35.0', dart: '3.9.0' }).state, 'incompatible');
  assert.equal(evaluateToolchain(req, pc, null).state, 'missing');
  writeFileSync(join(dir, '.fvmrc'), '{"flutter":"3.44.8"}');
  assert.ok(evaluateToolchain(projectRequirements(dir)!, pc, { flutter: '3.47.7', dart: '3.11.0' }).facts.some((f) => f.kind === 'toolchain_pin_mismatch'));
});
