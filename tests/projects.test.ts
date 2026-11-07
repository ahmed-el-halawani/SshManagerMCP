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

test('Git on both sides: following the plan literally (bundle, fast-forward, uncommitted copies) reaches verified', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  const { core, project, loc, pre } = setup(src, dst);
  const sh = (cmd: string) => { const r = spawnSync(process.env.FAKE_SH ?? 'C:\\Program Files\\Git\\bin\\sh.exe', ['-c', cmd], { encoding: 'utf8' }); assert.equal(r.status, 0, `${cmd}\n${r.stderr}`); };
  const verify = async (r: Pre) => (await core.verifyProjectSync({ project_id: project.id, destination_location_id: loc.id, expected_source_snapshot: r.source_snapshot, operation_id: key(), expected_generations: r.generations }) as Verify).outcome;
  /** An agent: bundle on the source, run every "host:" step as pasted, copy the listed uncommitted files. */
  const follow = (plan: Pre['suggested_plan'] & { steps: string[] }) => {
    sh(`git -C '${posixPath(src)}' bundle create /tmp/sshrm-sync.bundle main`);
    for (const s of plan.steps) if (s.startsWith('host: ')) sh(s.slice(6));
    for (const p of plan.copy ?? []) copyFileSync(join(src, p), join(dst, p));
  };

  // uncommitted source work is copied by hand and verified
  writeFileSync(join(src, 'a.txt'), 'wip\n');
  writeFileSync(join(src, 'new.txt'), 'untracked\n');
  let r = await pre();
  assert.equal(r.verdict, 'content_mismatch');
  for (const p of r.suggested_plan.copy ?? []) copyFileSync(join(src, p), join(dst, p));
  assert.equal(await verify(r), 'verified');

  // the source commits that work: the destination still holds it uncommitted, which would make --ff-only refuse
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'second');
  r = await pre();
  assert.equal(r.verdict, 'revision_mismatch');
  assert.equal(r.suggested_plan.kind, 'git_fast_forward');
  assert.deepEqual(r.suggested_plan.copy, []);
  follow(r.suggested_plan as never);
  assert.equal(git(dst, 'rev-parse', 'HEAD'), git(src, 'rev-parse', 'HEAD'));
  assert.equal((await pre()).verdict, 'ready');
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
  const { core, project, loc, pre } = setup(src, dst);
  const r = await pre();
  assert.equal(r.verdict, 'ready', JSON.stringify(r.facts));
  assert.ok(r.facts.some((f) => f.kind === 'scope_difference' && !f.blocking && !f.paths), 'summary leaves out paths of non-blocking facts');
  const full = await core.preflightProject({ project_id: project.id, destination_location_id: loc.id, detail: 'full' }) as Pre;
  assert.ok(full.facts.some((f) => f.kind === 'scope_difference' && f.paths?.includes('android/build/report.html')));
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

  // an uncommitted edit copied from this CRLF checkout must be turned back to LF on the host (seen on a real Mac)
  writeFileSync(join(crlf, 'a.txt'), 'line1\r\nline2\r\nwip\r\n');
  writeFileSync(join(crlf, 'new.txt'), 'untracked\r\n'); // untracked text: autocrlf normalises it too
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: crlf }); // source moves on: revision_mismatch -> git plan
  const plan = (await setup(crlf, dst).pre()).suggested_plan as { kind: string; copy: string[]; steps: string[] };
  assert.equal(plan.kind, 'git_fast_forward');
  assert.deepEqual(plan.copy.sort(), ['a.txt', 'new.txt']);
  const eol = plan.steps.find((s) => s.includes('perl -pi'));
  assert.ok(eol?.includes("'a.txt'") && eol.includes("'new.txt'"), JSON.stringify(plan.steps));
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
  // long TTL: the test itself can take >10 s on a slow CI runner; expiry is simulated explicitly below
  core.acquireLease({ location_id: loc.id, operation_id: 'op1', owner: 'agent-a', ttl_seconds: 600 });
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

type Sync = { outcome: string; files_copied: number };
const syncNow = (core: Core, project: { id: string }, loc: { id: string }) => core.syncProject({ project_id: project.id, destination_location_id: loc.id }) as Promise<Sync>;

test('Sync now (GUI): uncommitted files, then fast-forward with new commits, verified; MCP output carries no exec', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  const { core, project, loc, pre } = setup(src, dst);
  writeFileSync(join(src, 'a.txt'), 'wip\n');
  writeFileSync(join(src, 'src', 'new.txt'), 'untracked\n');
  const p0 = await pre() as Pre & { suggested_plan: { exec?: unknown; one_call?: string }; summary: { next_step: string } };
  assert.equal(p0.suggested_plan.exec, undefined, 'agents never see exec');
  assert.equal(p0.suggested_plan.one_call, 'ssh_projects_sync', 'agents are told the plan runs in one call');
  assert.match(p0.summary.next_step, /ssh_projects_sync/);
  let r = await syncNow(core, project, loc);
  assert.equal(r.outcome, 'verified');
  assert.equal(r.files_copied, 2);
  assert.equal(readFileSync(join(dst, 'src', 'new.txt'), 'utf8'), 'untracked\n');

  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'second');
  writeFileSync(join(src, 'later.txt'), 'after commit\n');
  r = await syncNow(core, project, loc);
  assert.equal(r.outcome, 'verified');
  assert.equal(git(dst, 'rev-parse', 'HEAD'), git(src, 'rev-parse', 'HEAD'));
  assert.equal((await pre()).verdict, 'ready');
  const hist = core.syncHistory({ destination_location_id: loc.id }).syncs as { outcome: string; transfer_mode: string; head: string; evidence: { verdict: string } }[];
  assert.deepEqual(hist.map((h) => h.outcome), ['verified', 'verified'], 'History tab lists both syncs, newest first');
  assert.equal(hist[0].head, git(src, 'rev-parse', 'HEAD'), 'with the source commit they were verified against');
  assert.equal(hist[0].transfer_mode, 'agent_sync', 'this core is the MCP side: ssh_projects_sync');
  core.acquireLease({ location_id: loc.id, operation_id: 'next', owner: 'agent' }); // the GUI lease was released
});

test('Sync now refuses when the destination has its own commits, and changes nothing', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  const { core, project, loc } = setup(src, dst);
  writeFileSync(join(dst, 'a.txt'), 'mac only\n');
  git(dst, 'commit', '-qam', 'mac-only commit');
  const head = git(dst, 'rev-parse', 'HEAD');
  git(src, 'commit', '-q', '--allow-empty', '-m', 'pc commit');
  await assert.rejects(syncNow(core, project, loc), (e: { message: string; details?: { verdict: string; blocking: { kind: string }[] } }) =>
    e.details?.verdict === 'destination_ahead' && (/refused by git, nothing was overwritten/.test(e.message) || e.details.blocking.some((f) => f.kind === 'destination_ahead')));
  assert.equal(git(dst, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(dst, 'a.txt'), 'utf8'), 'mac only\n');
});

test('Sync now clones a missing create_if_missing destination', async () => {
  const src = tempRepo();
  const dst = join(mkdtempSync(join(tmpdir(), 'sshrm-dst-')), 'fresh');
  const { core, project, loc } = setup(src, dst);
  core.updateProjectLocation({ location_id: loc.id, expected_revision: loc.revision, patch: { mode: 'create_if_missing' }, idempotency_key: key() });
  writeFileSync(join(src, 'wip.txt'), 'uncommitted\n');
  assert.equal((await syncNow(core, project, loc)).outcome, 'verified');
  assert.equal(git(dst, 'rev-parse', 'HEAD'), git(src, 'rev-parse', 'HEAD'));
  assert.equal(readFileSync(join(dst, 'wip.txt'), 'utf8'), 'uncommitted\n');
});

test('Sync now at scale: 120 new files, Unicode names, uncommitted delete/rename; a host reset back to HEAD is not "ahead"', async () => {
  const src = tempRepo({ 'a.txt': 'hello\n', 'src/b.txt': 'bee\n', 'old.txt': 'old\n', 'gone.txt': 'gone\n' });
  const dst = cloneTo(src);
  const { core, project, loc, pre } = setup(src, dst);
  mkdirSync(join(src, 'bulk dir'), { recursive: true });
  for (let i = 0; i < 120; i++) writeFileSync(join(src, 'bulk dir', `f ${i}.txt`), `n${i}\n`); // more than the 50 dirty paths an inspection stores
  writeFileSync(join(src, 'ملاحظات.md'), 'arabic name\n');
  git(src, 'mv', 'old.txt', 'renamed.txt');
  rmSync(join(src, 'gone.txt'));
  let r = await syncNow(core, project, loc);
  assert.equal(r.outcome, 'verified');
  assert.equal(readFileSync(join(dst, 'ملاحظات.md'), 'utf8'), 'arabic name\n');
  assert.ok(existsSync(join(dst, 'renamed.txt')) && !existsSync(join(dst, 'old.txt')) && !existsSync(join(dst, 'gone.txt')));

  // someone cleans the host back to HEAD (reset/checkout .): content is in Git, so this is not destination work
  git(dst, 'reset', '-q', '--hard');
  git(dst, 'clean', '-qfd');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'bulk');
  writeFileSync(join(src, 'later.txt'), 'later\n');
  assert.equal((await pre()).verdict, 'revision_mismatch');
  r = await syncNow(core, project, loc);
  assert.equal(r.outcome, 'verified');
  assert.equal(git(dst, 'rev-parse', 'HEAD'), git(src, 'rev-parse', 'HEAD'));
});

test('host files holding content the PC repo already has are not host work; real host edits can be backed up to a stash, then synced', async () => {
  const src = tempRepo({ 'a.txt': 'v1\n', 'c.txt': 'c1\n', 'mine.txt': 'base\n' });
  const dst = cloneTo(src);
  const { core, project, loc } = setup(src, dst, makeCore('gui'));
  writeFileSync(join(src, 'base.txt'), 'base\n');
  await syncNow(core, project, loc); // verified baseline
  writeFileSync(join(src, 'a.txt'), 'v2\n');
  git(src, 'commit', '-qam', 'v2');
  writeFileSync(join(src, 'a.txt'), 'v3\n');
  writeFileSync(join(src, 'mine.txt'), 'pc v3\n'); // the PC changed it too, so the host edit is in the way
  git(src, 'commit', '-qam', 'v3');
  // like the real Mac: an old source version sits in the host's working tree (reset back to an older HEAD), plus one real edit
  writeFileSync(join(dst, 'a.txt'), 'v2\n');
  writeFileSync(join(dst, 'mine.txt'), 'edited on the host\n');
  type Pre = { verdict: string; can_back_up: boolean; files: { path: string; host_dirty: boolean }[] };
  const r = await core.preflightProject({ project_id: project.id, destination_location_id: loc.id, intent: 'transfer' }) as Pre;
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.equal(by['a.txt'].host_dirty, false, 'v2 is in the PC history: replacing it loses nothing');
  assert.equal(by['mine.txt'].host_dirty, true, 'the PC never had this content');
  assert.equal(r.verdict, 'destination_dirty');
  assert.equal(r.can_back_up, true);
  await assert.rejects(syncNow(core, project, loc), /nothing Sync now can do safely/);
  assert.equal(readFileSync(join(dst, 'mine.txt'), 'utf8'), 'edited on the host\n', 'plain Sync never touches host work');
  const s = await core.syncProject({ project_id: project.id, destination_location_id: loc.id, backup_host_changes: true }) as Sync & { backup: { stashed: number } };
  assert.equal(s.outcome, 'verified');
  assert.equal(s.backup.stashed, 1);
  assert.equal(git(dst, 'rev-parse', 'HEAD'), git(src, 'rev-parse', 'HEAD'));
  assert.match(git(dst, 'stash', 'list'), /SSH Resource Manager backup before sync/);
  assert.equal(git(dst, 'stash', 'show', '--name-only'), 'mine.txt', 'only the host edit was stashed');
});

test('host edits the sync never touches are kept as they are: no backup needed, verified, still there afterwards', async () => {
  const src = tempRepo({ 'a.txt': 'v1\n', 'Podfile.lock': 'pods v1\n', 'pubspec.lock': 'pub v1\n' });
  const dst = cloneTo(src);
  const { core, project, loc } = setup(src, dst, makeCore('gui'));
  writeFileSync(join(src, 'base.txt'), 'base\n');
  await syncNow(core, project, loc);
  writeFileSync(join(src, 'a.txt'), 'v2\n');
  writeFileSync(join(src, 'pubspec.lock'), 'pub v2\n');
  git(src, 'commit', '-qam', 'v2');
  writeFileSync(join(dst, 'Podfile.lock'), 'pods from a Mac build\n'); // the PC never changed this file: no conflict
  writeFileSync(join(dst, 'build.log'), 'host only, untracked\n');
  writeFileSync(join(dst, 'pubspec.lock'), 'pub from a Mac build\n'); // the PC changed it too: a real conflict
  type Pre = { can_back_up: boolean; files: { path: string; status: string; host_dirty: boolean }[] };
  const r = await core.preflightProject({ project_id: project.id, destination_location_id: loc.id, intent: 'transfer' }) as Pre;
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.equal(by['Podfile.lock'].status, 'kept');
  assert.equal(by['build.log'].status, 'kept');
  assert.equal(by['pubspec.lock'].host_dirty, true);
  assert.equal(r.can_back_up, true);
  const s = await core.syncProject({ project_id: project.id, destination_location_id: loc.id, backup_host_changes: true }) as Sync & { backup: { stashed: number } };
  assert.equal(s.outcome, 'verified');
  assert.equal(s.backup.stashed, 1, 'only the conflicting file is stashed');
  assert.equal(git(dst, 'rev-parse', 'HEAD'), git(src, 'rev-parse', 'HEAD'));
  assert.equal(readFileSync(join(dst, 'Podfile.lock'), 'utf8'), 'pods from a Mac build\n');
  assert.equal(readFileSync(join(dst, 'build.log'), 'utf8'), 'host only, untracked\n');
  assert.equal(readFileSync(join(dst, 'pubspec.lock'), 'utf8').replaceAll('\r', ''), 'pub v2\n');
  // nothing in the way at all: a plain sync runs with the host edit in place
  writeFileSync(join(src, 'a.txt'), 'v3\n');
  git(src, 'commit', '-qam', 'v3');
  assert.equal((await syncNow(core, project, loc)).outcome, 'verified');
  assert.equal(readFileSync(join(dst, 'Podfile.lock'), 'utf8'), 'pods from a Mac build\n');
});

test('GUI file list marks host-dirty files; file preview diffs PC vs host and never reads credentials', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  const { core, project, loc } = setup(src, dst, makeCore('gui'));
  writeFileSync(join(src, 'base.txt'), 'base\n');
  await syncNow(core, project, loc); // a verified baseline, so host edits after it count as the host's own work
  writeFileSync(join(src, 'a.txt'), 'pc edit\n');
  writeFileSync(join(dst, 'src', 'new.txt'), 'host only\n');
  writeFileSync(join(src, 'b.txt'), 'pc\n');
  writeFileSync(join(dst, 'b.txt'), 'host\n');
  const r = await core.preflightProject({ project_id: project.id, destination_location_id: loc.id, intent: 'transfer' }) as { files: { path: string; status: string; host_dirty: boolean }[] };
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.equal(by['a.txt'].host_dirty, false, 'changed only on the PC: not dirty');
  assert.equal(by['b.txt'].host_dirty, true, 'changed on the host too: dirty');
  assert.equal(by['src/new.txt'].status, 'kept', 'a host-only file the sync never touches stays');
  const d = await core.diffProjectFile({ project_id: project.id, destination_location_id: loc.id, path: 'b.txt' }) as { diff: string };
  assert.match(d.diff, /^-host$/m);
  assert.match(d.diff, /^\+pc$/m);
  for (const bad of ['.env', '../x', '/etc/passwd', 'a/../../x']) await assert.rejects(core.diffProjectFile({ project_id: project.id, destination_location_id: loc.id, path: bad }));
  assert.equal((await core.preflightProject({ project_id: project.id, destination_location_id: loc.id }) as { files?: unknown }).files === undefined, false, 'gui core includes files');
  assert.equal((await setup(src, dst).pre() as { files?: unknown }).files, undefined, 'agents never get the file list');
});

test('a host-only leftover of a file the PC deleted in a commit is kept (GUI), not a blocker or a "From this PC" change', async () => {
  const src = tempRepo({ 'a.txt': 'v1\n', 'assets/old.mp3': 'old voice\n' });
  const dst = cloneTo(src);
  const { core, project, loc } = setup(src, dst, makeCore('gui'));
  git(src, 'rm', '-q', 'assets/old.mp3');
  git(src, 'commit', '-qm', 'drop old voice');
  assert.equal((await syncNow(core, project, loc)).outcome, 'verified');
  mkdirSync(join(dst, 'assets'), { recursive: true });
  writeFileSync(join(dst, 'assets', 'old.mp3'), 'old voice\n'); // put back on the host, untracked: content the PC repo knows
  type Pre = { verdict: string; files: { path: string; status: string }[] };
  const r = await core.preflightProject({ project_id: project.id, destination_location_id: loc.id, intent: 'transfer' }) as Pre;
  assert.equal(r.verdict, 'ready');
  assert.deepEqual(r.files.map((f) => [f.path, f.status]), [['assets/old.mp3', 'kept']]);
});

test('.sshrmignore: gitignore-style lines; ignored paths drop out of compare on both sides, for agents too', async () => {
  const { ignoreGlobs } = await import('../src/core/projects.ts');
  assert.deepEqual(ignoreGlobs('# c\n\n*.log\nbuild/\n/top.txt\na/b\n!keep\n'), ['**/*.log', '**/*.log/**', '**/build/**', 'top.txt', 'top.txt/**', 'a/b', 'a/b/**']);
  const src = tempRepo();
  const dst = cloneTo(src);
  const { core, project, pre } = setup(src, dst);
  writeFileSync(join(dst, 'host.log'), 'host only\n');
  mkdirSync(join(dst, 'cache'));
  writeFileSync(join(dst, 'cache', 'x.bin'), 'x\n');
  assert.equal((await pre()).verdict, 'destination_dirty');
  const e = core.editProjectIgnore({ project_id: project.id, add: ['*.log', 'cache/', '*.log'] }) as { added: string[]; patterns: string[] };
  assert.deepEqual(e.added, ['*.log', 'cache/']);
  assert.deepEqual((core.editProjectIgnore({ project_id: project.id }) as { patterns: string[] }).patterns, ['*.log', 'cache/'], 'no add/remove = read');
  assert.equal((await pre()).verdict, 'content_mismatch', 'the new .sshrmignore itself is an uncommitted source file to copy');
  git(src, 'add', '.sshrmignore');
  git(src, 'commit', '-qm', 'ignore');
  git(dst, 'pull', '-q', src, 'HEAD');
  assert.equal((await pre()).verdict, 'ready');
  core.editProjectIgnore({ project_id: project.id, remove: ['cache/'] });
  assert.match(readFileSync(join(src, '.sshrmignore'), 'utf8'), /^\*\.log$/m);
});

test('Sync now carries every branch and tag; a host branch with its own commits is left alone', async () => {
  const src = tempRepo();
  const dst = cloneTo(src);
  const { core, project, loc } = setup(src, dst, makeCore('gui'));
  const main = git(src, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(src, 'switch', '-qc', 'feature');
  git(src, 'commit', '-q', '--allow-empty', '-m', 'feature work');
  git(src, 'switch', '-qc', 'mine');
  git(src, 'commit', '-q', '--allow-empty', '-m', 'pc side');
  git(src, 'switch', '-q', main);
  git(src, 'commit', '-q', '--allow-empty', '-m', 'main moves');
  git(src, 'tag', 'v1');
  git(dst, 'branch', 'mine', git(dst, 'rev-parse', 'HEAD'));
  git(dst, 'switch', '-q', 'mine');
  git(dst, 'commit', '-q', '--allow-empty', '-m', 'host side');
  const hostMine = git(dst, 'rev-parse', 'HEAD');
  git(dst, 'switch', '-q', main);
  const r = await syncNow(core, project, loc) as Sync & { branches: { updated: string[]; skipped: string[] } };
  assert.equal(r.outcome, 'verified');
  assert.deepEqual(r.branches, { updated: ['feature'], skipped: ['mine'] });
  assert.equal(git(dst, 'rev-parse', 'feature'), git(src, 'rev-parse', 'feature'));
  assert.equal(git(dst, 'rev-parse', 'mine'), hostMine, 'diverged host branch untouched');
  assert.equal(git(dst, 'rev-parse', 'v1'), git(src, 'rev-parse', 'v1'));
});

test('agent copies an uncommitted file with Windows line endings: not host work; the plan says how to fix it, then verify passes', async () => {
  const src = tempRepo({ 'README.md': 'hello\n', 'src/a.txt': 'a\n' });
  const dst = cloneTo(src);
  git(dst, 'config', 'core.autocrlf', 'false'); // a Mac: no line-ending conversion
  git(src, 'config', 'core.autocrlf', 'true'); // a Windows checkout: CRLF in the working tree, LF in Git
  writeFileSync(join(src, 'README.md'), 'hello\r\nSearch: search(text) returns matching note ids.\r\n');
  const { core, project, loc, pre } = setup(src, dst);
  copyFileSync(join(src, 'README.md'), join(dst, 'README.md')); // what an agent does with scp: raw bytes, CRLF included
  const r = await pre() as Pre & { suggested_plan: { steps: string[] } };
  assert.equal(r.verdict, 'content_mismatch', 'the PC\'s own bytes on the host are not "destination work"');
  assert.ok(r.suggested_plan.steps.some((s) => s.includes('perl -pi -e') && s.includes('README.md')), 'the plan carries the line-ending fix');
  writeFileSync(join(dst, 'README.md'), readFileSync(join(dst, 'README.md'), 'utf8').replaceAll('\r\n', '\n')); // the perl step
  const v = await core.verifyProjectSync({ project_id: project.id, destination_location_id: loc.id, expected_source_snapshot: r.source_snapshot, operation_id: 'agent-1', expected_generations: r.generations }) as Verify;
  assert.equal(v.outcome, 'verified');
});
