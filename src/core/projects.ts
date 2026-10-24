import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, matchesGlob, win32, posix } from 'node:path';
import { z } from 'zod';
import { sshRun, type Ctx } from './checks.ts';
import { type DB, now, tx } from './db.ts';
import { AppError, notFound } from './errors.ts';
import { audit, checkIdempotency, getHostRow, recordIdempotency } from './hosts.ts';
import { executionEnvironment } from './paths.ts';
import { ConsistencyPolicy, IdemKey, LocationSpec } from './schemas.ts';
import { getSettings } from './settings.ts';
import { classify, diagnostics, posixQuote, run, sanitize, splitCommand } from './ssh.ts';

// ---------------- registry ----------------

type LocationRow = {
  id: string; project_id: string; host_id: string | null; execution_environment: string; label: string;
  path_input: string | null; canonical_path: string | null; path_flavor: 'windows' | 'posix'; mode: string; role: string;
  enabled: number; revision: number; location_generation: number; git_root: string | null; project_subdirectory: string | null;
  identity_state: string; last_inspection_id: string | null; consistency_policy_json: string; last_verified_sync_id: string | null;
};
type ProjectRow = { id: string; name: string; description: string; source_location_id: string | null; repository_identity_json: string | null; repo_subdirectory: string | null; revision: number; created_at: string; updated_at: string };

const getProjectRow = (db: DB, id: string) => {
  const r = db.prepare('SELECT * FROM projects WHERE id=?').get(id) as ProjectRow | undefined;
  if (!r) throw notFound('project', id);
  return r;
};
const getLocationRow = (db: DB, id: string) => {
  const r = db.prepare('SELECT * FROM project_locations WHERE id=?').get(id) as LocationRow | undefined;
  if (!r) throw notFound('location', id);
  return r;
};
const policyOf = (l: LocationRow) => ConsistencyPolicy.parse(JSON.parse(l.consistency_policy_json));
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function validatePath(path: string, flavor: 'windows' | 'posix') {
  if (flavor === 'windows' ? !win32.isAbsolute(path) : !(path.startsWith('/') || path === '~' || path.startsWith('~/'))) {
    throw new AppError('VALIDATION_ERROR', flavor === 'windows' ? 'local path must be absolute (e.g. C:\\src\\app)' : 'remote path must be absolute (/...) or start with ~/');
  }
}

function insertLocation(db: DB, projectId: string, spec: z.infer<typeof LocationSpec>, role: 'source' | 'execution') {
  let flavor: 'windows' | 'posix' = process.platform === 'win32' ? 'windows' : 'posix';
  let env: string = executionEnvironment();
  if (spec.host_id) {
    const h = getHostRow(db, spec.host_id);
    flavor = (h.observed_os ?? h.declared_os) === 'windows' ? 'windows' : 'posix';
    env = `remote:${h.observed_os ?? h.declared_os}`;
  }
  if (spec.path) validatePath(spec.path, flavor);
  const id = randomUUID();
  const t = now();
  db.prepare(`INSERT INTO project_locations(id, project_id, host_id, execution_environment, label, path_input, path_flavor, mode, role, consistency_policy_json, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, spec.host_id, env, spec.label, spec.path ?? null, flavor, spec.mode, role, JSON.stringify(ConsistencyPolicy.parse(spec.policy ?? {})), t, t);
  return id;
}

function locationDto(db: DB, l: LocationRow) {
  const insp = l.last_inspection_id ? db.prepare('SELECT inspected_at, path_state, result_json, snapshot_id FROM inspections WHERE id=?').get(l.last_inspection_id) as
    { inspected_at: string; path_state: string; result_json: string; snapshot_id: string } | undefined : undefined;
  const r = insp ? JSON.parse(insp.result_json) : null;
  const sync = l.last_verified_sync_id ? db.prepare('SELECT verified_at, expected_source_snapshot FROM sync_verifications WHERE id=?').get(l.last_verified_sync_id) : null;
  const attempt = db.prepare('SELECT outcome, started_at FROM sync_verifications WHERE destination_location_id=? ORDER BY started_at DESC LIMIT 1').get(l.id) ?? null;
  return {
    id: l.id, project_id: l.project_id, host_id: l.host_id, label: l.label, role: l.role, mode: l.mode, enabled: !!l.enabled,
    path_input: l.path_input, canonical_path: l.canonical_path, path_flavor: l.path_flavor, path_state: l.path_input ? (insp?.path_state ?? 'unverified') : 'unset',
    execution_environment: l.execution_environment, revision: l.revision, location_generation: l.location_generation,
    identity_state: l.identity_state, git_root: l.git_root, project_subdirectory: l.project_subdirectory, policy: policyOf(l),
    last_inspection: insp ? { at: insp.inspected_at, snapshot_id: insp.snapshot_id, branch: r?.git?.branch ?? null, head: r?.git?.head?.slice(0, 12) ?? null,
      detached: r?.git?.detached ?? null, dirty: r?.git ? { staged: r.git.staged, unstaged: r.git.unstaged, untracked: r.git.untracked, conflicts: r.git.conflicts } : null,
      age_seconds: Math.round((Date.now() - Date.parse(insp.inspected_at)) / 1000) } : null,
    last_verified_sync: sync, last_sync_attempt: attempt,
  };
}

export function getProject(db: DB, projectId: string) {
  const p = getProjectRow(db, projectId);
  const locs = db.prepare('SELECT * FROM project_locations WHERE project_id=? ORDER BY role DESC, created_at').all(projectId) as LocationRow[];
  return { ...p, repository_identity: p.repository_identity_json ? JSON.parse(p.repository_identity_json) : null, repository_identity_json: undefined, locations: locs.map((l) => locationDto(db, l)) };
}

export function listProjects(db: DB, filters: { query?: string; host_id?: string } = {}) {
  const rows = db.prepare('SELECT id FROM projects ORDER BY name').all() as { id: string }[];
  return { projects: rows.map((r) => getProject(db, r.id)).filter((p) =>
    (!filters.query || p.name.toLowerCase().includes(filters.query.toLowerCase()))
    && (!filters.host_id || p.locations.some((l) => l.host_id === filters.host_id))) };
}

export function registerProject(ctx: Ctx, raw: unknown) {
  const input = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(5000).default(''), source_location: LocationSpec,
    repository_hint: z.string().max(500).optional(), idempotency_key: IdemKey }).strict().parse(raw);
  return tx(ctx.db, () => {
    const prev = checkIdempotency(ctx.db, input.idempotency_key, 'register_project', input);
    if (prev) return { project: getProject(ctx.db, prev), replayed: true };
    const id = randomUUID();
    const t = now();
    ctx.db.prepare('INSERT INTO projects(id, name, description, created_at, updated_at) VALUES(?,?,?,?,?)').run(id, input.name, input.description, t, t);
    const loc = insertLocation(ctx.db, id, input.source_location, 'source');
    ctx.db.prepare('UPDATE projects SET source_location_id=? WHERE id=?').run(loc, id);
    recordIdempotency(ctx.db, input.idempotency_key, 'register_project', input, id);
    audit(ctx.db, ctx.source, 'register_project', null, null, 1, { project_id: id });
    return { project: getProject(ctx.db, id), replayed: false, note: 'Nothing was cloned, created or copied.' };
  });
}

export function bindProjectLocation(ctx: Ctx, raw: unknown) {
  const input = LocationSpec.extend({ project_id: z.uuid(), expected_project_revision: z.number().int(), idempotency_key: IdemKey }).strict().parse(raw);
  return tx(ctx.db, () => {
    const prev = checkIdempotency(ctx.db, input.idempotency_key, 'bind_project_location', input);
    if (prev) return { location: locationDto(ctx.db, getLocationRow(ctx.db, prev)), replayed: true };
    const p = getProjectRow(ctx.db, input.project_id);
    if (p.revision !== input.expected_project_revision) throw new AppError('REVISION_CONFLICT', 'project changed', { details: { current_revision: p.revision } });
    const { project_id, expected_project_revision: _r, idempotency_key: _k, ...spec } = input;
    const id = insertLocation(ctx.db, project_id, spec, 'execution');
    ctx.db.prepare('UPDATE projects SET revision=revision+1, updated_at=? WHERE id=?').run(now(), project_id);
    recordIdempotency(ctx.db, input.idempotency_key, 'bind_project_location', input, id);
    audit(ctx.db, ctx.source, 'bind_project_location', input.host_id, null, null, { project_id, location_id: id });
    return { location: locationDto(ctx.db, getLocationRow(ctx.db, id)), replayed: false,
      note: input.path ? 'Bound as adopt-existing; nothing was created or copied. Run inspect_project next.' : 'Path is unset; this location is not executable until a path is set.' };
  });
}

export function updateProjectLocation(ctx: Ctx, raw: unknown) {
  const input = z.object({
    location_id: z.uuid(), expected_revision: z.number().int(), idempotency_key: IdemKey,
    patch: z.object({ path: z.string().min(1).max(4096).nullable().optional(), label: z.string().max(200).optional(), enabled: z.boolean().optional(),
      mode: z.enum(['adopt_existing', 'create_if_missing']).optional(), policy: ConsistencyPolicy.partial().optional(),
      confirm_identity: z.boolean().optional() }).strict(),
  }).strict().parse(raw);
  return tx(ctx.db, () => {
    const prev = checkIdempotency(ctx.db, input.idempotency_key, 'update_project_location', input);
    if (prev) return { location: locationDto(ctx.db, getLocationRow(ctx.db, prev)), replayed: true };
    const l = getLocationRow(ctx.db, input.location_id);
    if (l.revision !== input.expected_revision) throw new AppError('REVISION_CONFLICT', 'location changed; reload', { details: { current_revision: l.revision } });
    const pt = input.patch;
    if (pt.path) validatePath(pt.path, l.path_flavor);
    const pathChanged = pt.path !== undefined && pt.path !== l.path_input;
    const policyChanged = pt.policy !== undefined;
    const invalidate = pathChanged || policyChanged || pt.mode !== undefined;
    const policy = { ...policyOf(l), ...pt.policy };
    ctx.db.prepare(`UPDATE project_locations SET path_input=?, canonical_path=?, label=?, enabled=?, mode=?, consistency_policy_json=?, identity_state=?,
      location_generation=location_generation+?, last_inspection_id=?, last_verified_sync_id=?, git_root=?, project_subdirectory=?, revision=revision+1, updated_at=? WHERE id=?`)
      .run(pathChanged ? pt.path ?? null : l.path_input, pathChanged ? null : l.canonical_path, pt.label ?? l.label, (pt.enabled ?? !!l.enabled) ? 1 : 0,
        pt.mode ?? l.mode, JSON.stringify(ConsistencyPolicy.parse(policy)),
        pt.confirm_identity ? 'user_confirmed' : pathChanged ? 'unverified' : l.identity_state,
        invalidate ? 1 : 0, invalidate ? null : l.last_inspection_id, invalidate ? null : l.last_verified_sync_id,
        pathChanged ? null : l.git_root, pathChanged ? null : l.project_subdirectory, now(), l.id);
    if (invalidate) ctx.db.prepare('DELETE FROM project_operation_leases WHERE destination_location_id=?').run(l.id);
    recordIdempotency(ctx.db, input.idempotency_key, 'update_project_location', input, l.id);
    audit(ctx.db, ctx.source, 'update_project_location', l.host_id, l.revision, l.revision + 1, { location_id: l.id, old_path: l.path_input, new_path: pt.path });
    return { location: locationDto(ctx.db, getLocationRow(ctx.db, l.id)), replayed: false,
      ...(pathChanged ? { note: `Path changed from ${l.path_input ?? '(unset)'} to ${pt.path ?? '(unset)'}. No files were moved or deleted; previous verification is invalidated.` } : {}) };
  });
}

export function unbindProjectLocation(ctx: Ctx, raw: unknown) {
  const input = z.object({ location_id: z.uuid(), expected_revision: z.number().int() }).strict().parse(raw);
  return tx(ctx.db, () => {
    const l = getLocationRow(ctx.db, input.location_id);
    if (l.revision !== input.expected_revision) throw new AppError('REVISION_CONFLICT', 'location changed', { details: { current_revision: l.revision } });
    const p = getProjectRow(ctx.db, l.project_id);
    if (p.source_location_id === l.id) throw new AppError('VALIDATION_ERROR', 'cannot unbind the source location; choose another source first');
    ctx.db.prepare('DELETE FROM project_locations WHERE id=?').run(l.id);
    audit(ctx.db, ctx.source, 'unbind_project_location', l.host_id, l.revision, null, { location_id: l.id });
    return { removed: l.id, note: 'Metadata only. No remote or local directory was touched.' };
  });
}

export function removeProject(ctx: Ctx, raw: unknown) {
  const input = z.object({ project_id: z.uuid(), expected_revision: z.number().int() }).strict().parse(raw);
  return tx(ctx.db, () => {
    const p = getProjectRow(ctx.db, input.project_id);
    if (p.revision !== input.expected_revision) throw new AppError('REVISION_CONFLICT', 'project changed', { details: { current_revision: p.revision } });
    ctx.db.prepare('DELETE FROM projects WHERE id=?').run(p.id);
    return { removed: p.id, note: 'Metadata only. No files were touched.' };
  });
}

// ---------------- inspection ----------------

const CREDENTIAL_EXCLUDES = ['.env', '.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/*.p12', '**/id_rsa*', '**/id_ed25519*'];
const NON_GIT_EXCLUDES = ['.git', '.git/**', '**/node_modules/**', '**/.dart_tool/**', '**/build/**', '**/Pods/**', '**/.gradle/**', '**/DerivedData/**', '**/__pycache__/**', '**/.venv/**', '**/dist/**'];
const ROOT_ISSUE = 'path is a home or filesystem root, not a project directory; not scanned';
const PRUNE_NAMES =['.git', 'node_modules', '.dart_tool', 'build', 'Pods', '.gradle', 'DerivedData', '__pycache__', '.venv', 'dist'];

/** h = sha256 of the bytes; g = Git blob id (after Git's eol/clean filters), present when the side is a Git repo. */
type Entry = { p: string; t: 'f' | 'l'; h: string; g?: string };
export type GitFacts = {
  available: boolean; is_repo: boolean; root?: string; subdir?: string; branch?: string | null; detached?: boolean; head?: string | null;
  root_commits?: string[]; remotes?: string[]; git_dir_is_file?: boolean;
  staged: number; unstaged: number; untracked: number; conflicts: number; dirty_paths: string[];
};
export type Inspection = {
  path_state: 'unset' | 'missing' | 'not_directory' | 'exists' | 'inaccessible';
  canonical_path?: string; home?: string; git?: GitFacts; layout_issues: string[];
  manifest?: { count: number; digest: string; excluded: number; entries: Entry[] };
  error?: { code: string; message: string; diagnostics?: unknown };
  stable: boolean;
};

const sanitizeRemote = (url: string) => sanitize(url).replace(/\s+\((fetch|push)\)$/, '');

/** porcelain v2 -z parser. */
export function parseStatus(z0: string) {
  const items = z0.split('\0');
  const r = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, dirty_paths: [] as string[] };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const kind = it[0];
    const fieldsBeforePath = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : 1;
    const parts = it.split(' ');
    const path = parts.slice(fieldsBeforePath).join(' ');
    if (kind === '2') i++; // original path follows as its own NUL item
    if (kind === '?') { r.untracked++; r.dirty_paths.push(path); continue; }
    if (kind === '!') continue;
    if (kind === 'u') { r.conflicts++; r.dirty_paths.push(path); continue; }
    if (kind === '1' || kind === '2') {
      const xy = parts[1];
      if (xy[0] !== '.') r.staged++;
      if (xy[1] !== '.') r.unstaged++;
      r.dirty_paths.push(path);
    }
  }
  return r;
}

function layoutIssues(files: string[], links: { p: string; target: string }[], hasSubmodules: boolean, lfs: boolean) {
  const issues: string[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    const k = f.toLowerCase();
    if (seen.has(k) && seen.get(k) !== f) issues.push(`case_collision: '${seen.get(k)}' vs '${f}' (unsafe on case-insensitive filesystems)`);
    seen.set(k, f);
  }
  for (const l of links) {
    const resolved = posix.normalize(posix.join(posix.dirname(l.p), l.target));
    if (l.target.startsWith('/') || /^[A-Za-z]:/.test(l.target) || resolved.startsWith('..')) issues.push(`symlink_escapes_project: ${l.p} -> ${l.target}`);
  }
  if (hasSubmodules) issues.push('submodules_present: submodule content is not verified by this manager');
  if (lfs) issues.push('git_lfs_present: pointer files are not proof of content');
  return issues.slice(0, 50);
}

function applyExclusions(files: string[], isRepo: boolean, policy: ConsistencyPolicy) {
  const patterns = [...CREDENTIAL_EXCLUDES, ...(isRepo ? [] : NON_GIT_EXCLUDES), ...policy.exclusions];
  const kept: string[] = [];
  let excluded = 0;
  for (const f of files) {
    if (patterns.some((g) => matchesGlob(f, g))) excluded++;
    else kept.push(f);
  }
  return { kept, excluded };
}

/**
 * Git blob ids via `git hash-object --stdin-paths`, which applies the repo's eol/clean filters.
 * Windows (autocrlf) and macOS checkouts of the same commit have different bytes but identical blobs.
 */
async function addGitBlobIds(entries: Entry[], hash: (input: string) => Promise<{ stdout: string; exit_code: number | null }>) {
  const files = entries.filter((e) => e.t === 'f' && !e.p.includes('\n'));
  if (!files.length) return;
  const r = await hash(files.map((e) => e.p).join('\n') + '\n');
  const ids = r.stdout.split(/\r?\n/).filter((l) => /^[0-9a-f]{40,64}$/.test(l));
  if (r.exit_code !== 0 || ids.length !== files.length) return; // fall back to byte comparison only
  files.forEach((e, i) => { e.g = ids[i]; });
}

const finishManifest =(entries: Entry[], excluded: number) => {
  entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return { count: entries.length, excluded, entries, digest: sha(entries.map((e) => `${e.p}\0${e.t}\0${e.h}`).join('\n')) };
};

async function inspectLocal(ctx: Ctx, path: string, policy: ConsistencyPolicy): Promise<Inspection> {
  const s = getSettings(ctx.db);
  let st;
  try { st = statSync(path); } catch (e) {
    return { path_state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'inaccessible', layout_issues: [], stable: true };
  }
  if (!st.isDirectory()) return { path_state: 'not_directory', layout_issues: [], stable: true };
  const canonical = realpathSync.native(path);
  if (win32.parse(canonical).root === canonical || canonical.toLowerCase() === realpathSync.native(homedir()).toLowerCase()) {
    return { path_state: 'exists', canonical_path: canonical, layout_issues: [ROOT_ISSUE], stable: true };
  }
  const git = splitCommand(s.git_path);
  const g = (args: string[], max?: number, input?: string) => run(git, ['-c', 'core.quotepath=off', ...args], { cwd: canonical, timeoutMs: s.inspect_timeout_s * 1000, maxBytes: max, input });
  const probe = await g(['rev-parse', '--is-inside-work-tree']);
  const available = probe.spawn_error !== 'ENOENT';
  const isRepo = available && probe.exit_code === 0 && probe.stdout.trim() === 'true';
  let facts: GitFacts = { available, is_repo: isRepo, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, dirty_paths: [] };
  let files: string[];
  const statusOf = async () => (await g(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.'], 32 << 20)).stdout;
  let statusBefore = '';
  if (isRepo) {
    const top = (await g(['rev-parse', '--show-toplevel'])).stdout.trim();
    statusBefore = await statusOf();
    facts = {
      ...facts, root: top, subdir: (await g(['rev-parse', '--show-prefix'])).stdout.trim().replace(/\/$/, ''),
      branch: (await g(['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim() || null,
      head: (await g(['rev-parse', '-q', '--verify', 'HEAD'])).stdout.trim() || null,
      root_commits: (await g(['rev-list', '--max-parents=0', 'HEAD'])).stdout.split(/\s+/).filter(Boolean).sort(),
      remotes: [...new Set((await g(['remote', '-v'])).stdout.split(/\r?\n/).filter(Boolean).map(sanitizeRemote))],
      git_dir_is_file: (() => { try { return lstatSync(join(top, '.git')).isFile(); } catch { return false; } })(),
      ...parseStatus(statusBefore),
    };
    facts.detached = !facts.branch;
    facts.dirty_paths = facts.dirty_paths.slice(0, 50);
    files = (await g(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 64 << 20)).stdout.split('\0').filter(Boolean);
  } else {
    files = [];
    const walk = (rel: string) => {
      const fs = readdirSafe(join(canonical, rel));
      for (const d of fs) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) { if (!PRUNE_NAMES.includes(d.name)) walk(r); } else files.push(r);
      }
    };
    walk('');
  }
  const { kept, excluded } = applyExclusions(files, isRepo, policy);
  const entries: Entry[] = [];
  const links: { p: string; target: string }[] = [];
  for (const f of kept) {
    const abs = join(canonical, f);
    try {
      const ls = lstatSync(abs);
      if (ls.isSymbolicLink()) { const t = readlinkSync(abs).replaceAll('\\', '/'); links.push({ p: f, target: t }); entries.push({ p: f, t: 'l', h: sha(t) }); }
      else if (ls.isFile()) entries.push({ p: f, t: 'f', h: sha(readFileSync(abs)) }); // ponytail: whole-file read; stream if multi-GB assets matter
    } catch { /* tracked but deleted in working tree: not part of content */ }
  }
  if (isRepo) await addGitBlobIds(entries, (input) => g(['hash-object', '--stdin-paths'], 64 << 20, input));
  const stable = !isRepo || (await statusOf()) === statusBefore;
  return {
    path_state: 'exists', canonical_path: canonical, git: facts, stable,
    layout_issues: layoutIssues(kept, links, kept.includes('.gitmodules'), kept.includes('.gitattributes') && readFileSync(join(canonical, '.gitattributes'), 'utf8').includes('filter=lfs')),
    manifest: finishManifest(entries, excluded),
  };
}

function readdirSafe(dir: string) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Remote inspection: POSIX hosts only in v1. The path travels quoted as data; never interpolated raw. */
function remoteScript(pathInput: string) {
  const assign = pathInput === '~' ? 'P="$HOME"' : pathInput.startsWith('~/') ? `P="$HOME"/${posixQuote(pathInput.slice(2))}` : `P=${posixQuote(pathInput)}`;
  const prune = PRUNE_NAMES.map((n) => `-name ${posixQuote(n)}`).join(' -o ');
  return `${assign}
echo "@@HOME $HOME"
if [ ! -e "$P" ]; then echo "@@STATE missing"; exit 0; fi
if [ ! -d "$P" ]; then echo "@@STATE not_directory"; exit 0; fi
cd -- "$P" 2>/dev/null || { echo "@@STATE inaccessible"; exit 0; }
echo "@@STATE exists"
echo "@@CANON $(pwd -P)"
if [ "$(pwd -P)" = / ] || [ "$(pwd -P)" = "$(cd -- "$HOME" && pwd -P)" ]; then echo "@@ROOTDIR 1"; exit 0; fi
if command -v git >/dev/null 2>&1; then echo "@@GIT 1"; G=1; else echo "@@GIT 0"; G=0; fi
if [ "$G" = 1 ] && [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then
  T=$(git rev-parse --show-toplevel)
  echo "@@REPO 1"; echo "@@TOP $T"; echo "@@PREFIX $(git rev-parse --show-prefix)"
  echo "@@BRANCH $(git symbolic-ref -q --short HEAD)"; echo "@@HEAD $(git rev-parse -q --verify HEAD)"
  echo "@@ROOTS $(git rev-list --max-parents=0 HEAD 2>/dev/null | tr '\\n' ' ')"
  if [ -f "$T/.git" ]; then echo "@@GITDIRFILE 1"; else echo "@@GITDIRFILE 0"; fi
  echo "@@REMOTES"; git remote -v 2>/dev/null; echo "@@END"
  printf '@@STATUS\\n'; git -c core.quotepath=off status --porcelain=v2 -z --untracked-files=all -- .; printf '\\n@@END\\n'
  printf '@@FILES\\n'; git -c core.quotepath=off ls-files -z --cached --others --exclude-standard; printf '\\n@@END\\n'
  printf '@@STATUS2\\n'; git -c core.quotepath=off status --porcelain=v2 -z --untracked-files=all -- .; printf '\\n@@END\\n'
else
  echo "@@REPO 0"
  printf '@@FILES\\n'; find . \\( ${prune} \\) -prune -o \\( -type f -o -type l \\) -print0; printf '\\n@@END\\n'
fi
printf '@@LINKS\\n'; find . -path ./.git -prune -o -type l -print 2>/dev/null | while IFS= read -r l; do printf '%s\\t%s\\n' "$l" "$(readlink "$l")"; done; printf '@@END\\n'
`;
}

const section = (out: string, name: string) => {
  const start = out.indexOf(`@@${name}\n`);
  if (start < 0) return '';
  const end = out.indexOf('\n@@END', start + name.length + 3);
  return out.slice(start + name.length + 3, end < 0 ? undefined : end);
};
const field = (out: string, name: string) => new RegExp(`^@@${name} ?(.*)$`, 'm').exec(out)?.[1]?.trim();

async function inspectRemote(ctx: Ctx, hostId: string, pathInput: string, policy: ConsistencyPolicy): Promise<Inspection> {
  const host = getHostRow(ctx.db, hostId);
  if ((host.observed_os ?? host.declared_os) === 'windows') {
    return { path_state: 'inaccessible', layout_issues: [], stable: true, error: { code: 'PROBE_UNSUPPORTED', message: 'project inspection on Windows remote hosts is not supported in v1 (POSIX hosts only)' } };
  }
  const s = getSettings(ctx.db);
  const r = await sshRun(ctx, host, remoteScript(pathInput), s.inspect_timeout_s, { maxBytes: 64 << 20 });
  const out = r.stdout.replaceAll('\r\n', '\n');
  const state = field(out, 'STATE') as Inspection['path_state'] | undefined;
  if (!state) {
    const c = classify(r);
    return { path_state: 'inaccessible', layout_issues: [], stable: false, error: { code: c.code, message: c.message, diagnostics: diagnostics(r) } };
  }
  const home = field(out, 'HOME');
  if (state === 'inaccessible' && (host.observed_os ?? host.declared_os) === 'macos' && /(^~|\/Users\/[^/]+)\/(Documents|Desktop|Downloads)(\/|$)/.test(pathInput)) {
    return { path_state: state, home, layout_issues: [], stable: true, error: { code: 'MACOS_PRIVACY_BLOCKED', message: 'macOS privacy blocks SSH from this folder. Enable System Settings → General → Sharing → Remote Login (i) → "Allow full disk access for remote users", or use a folder outside Documents/Desktop/Downloads.' } };
  }
  if (state !== 'exists') return { path_state: state, home, layout_issues: [], stable: true };
  const canonical = field(out, 'CANON')!;
  if (field(out, 'ROOTDIR')) return { path_state: 'exists', canonical_path: canonical, home, layout_issues: [ROOT_ISSUE], stable: true };
  const isRepo = field(out, 'REPO') === '1';
  let facts: GitFacts = { available: field(out, 'GIT') === '1', is_repo: isRepo, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, dirty_paths: [] };
  const status = section(out, 'STATUS');
  if (isRepo) {
    facts = {
      ...facts, root: field(out, 'TOP'), subdir: (field(out, 'PREFIX') ?? '').replace(/\/$/, ''),
      branch: field(out, 'BRANCH') || null, head: field(out, 'HEAD') || null,
      root_commits: (field(out, 'ROOTS') ?? '').split(/\s+/).filter(Boolean).sort(),
      remotes: [...new Set(section(out, 'REMOTES').split('\n').filter(Boolean).map(sanitizeRemote))],
      git_dir_is_file: field(out, 'GITDIRFILE') === '1', ...parseStatus(status),
    };
    facts.detached = !facts.branch;
    facts.dirty_paths = facts.dirty_paths.slice(0, 50);
  }
  const files = section(out, 'FILES').split('\0').map((f) => f.replace(/^\.\//, '')).filter(Boolean);
  const links = section(out, 'LINKS').split('\n').filter(Boolean).map((l) => { const [a, b] = l.split('\t'); return { p: a.replace(/^\.\//, ''), target: b ?? '' }; });
  const linkSet = new Set(links.map((l) => l.p));
  const { kept, excluded } = applyExclusions(files, isRepo, policy);
  const toHash = kept.filter((f) => !linkSet.has(f));
  const hashScript = `cd -- ${posixQuote(canonical)} || exit 3
if command -v sha256sum >/dev/null 2>&1; then H=sha256sum; else H="shasum -a 256"; fi
xargs -0 $H 2>/dev/null; echo "@@DONE"`;
  const hr = toHash.length
    ? await sshRun(ctx, host, hashScript, s.inspect_timeout_s, { maxBytes: 64 << 20, input: toHash.join('\0') + '\0' })
    : null;
  if (hr && !hr.stdout.includes('@@DONE')) {
    const c = classify(hr);
    return { path_state: 'exists', canonical_path: canonical, home, git: facts, layout_issues: [], stable: false, error: { code: c.code, message: `hashing failed: ${c.message}`, diagnostics: diagnostics(hr) } };
  }
  const entries: Entry[] = [];
  for (const line of (hr?.stdout ?? '').split('\n')) {
    const m = /^(\\?)([0-9a-f]{64}) [ *](.*)$/.exec(line.replace(/\r$/, ''));
    if (!m || m[3] === '-') continue;
    const name = m[1] ? m[3].replaceAll('\\n', '\n').replaceAll('\\\\', '\\') : m[3];
    entries.push({ p: name.replace(/^\.\//, ''), t: 'f', h: m[2] });
  }
  const keptSet = new Set(kept);
  const scopedLinks = links.filter((x) => keptSet.has(x.p)); // ignored build output (ios/.symlinks, ephemeral/) is out of scope
  for (const l of scopedLinks) entries.push({ p: l.p, t: 'l', h: sha(l.target) });
  if (isRepo) await addGitBlobIds(entries, (input) => sshRun(ctx, host, `cd -- ${posixQuote(canonical)} && git hash-object --stdin-paths`, s.inspect_timeout_s, { maxBytes: 64 << 20, input }));
  return {
    path_state: 'exists', canonical_path: canonical, home, git: facts, stable: !isRepo || section(out, 'STATUS2') === status,
    layout_issues: layoutIssues(kept, scopedLinks, keptSet.has('.gitmodules'), false), manifest: finishManifest(entries, excluded),
  };
}

async function inspectLocation(ctx: Ctx, project: ProjectRow, l: LocationRow): Promise<{ id: string; inspection: Inspection; snapshot_id: string | null }> {
  const policy = policyOf(l);
  const gen = l.location_generation;
  let insp: Inspection;
  if (!l.path_input) insp = { path_state: 'unset', layout_issues: [], stable: true };
  else if (l.host_id) insp = await inspectRemote(ctx, l.host_id, l.path_input, policy);
  else insp = await inspectLocal(ctx, l.path_input, policy);
  const snapshot = insp.manifest ? `snap_${sha(`${insp.git?.head ?? 'nohead'}|${insp.manifest.digest}|${sha(JSON.stringify(policy))}`).slice(0, 24)}` : null;
  const id = randomUUID();
  const manifestRef = insp.manifest ? join(ctx.dataDir, 'manifests', `${id}.json`) : null;
  if (manifestRef) writeFileSync(manifestRef, JSON.stringify(insp.manifest!.entries));
  const hostGen = l.host_id ? getHostRow(ctx.db, l.host_id).identity_generation : null;
  tx(ctx.db, () => {
    const { manifest, ...rest } = insp;
    const stored = { ...rest, manifest: manifest ? { count: manifest.count, digest: manifest.digest, excluded: manifest.excluded } : undefined };
    ctx.db.prepare(`INSERT INTO inspections(id, project_id, location_id, location_revision, location_generation, host_identity_generation, inspected_at, path_state, result_json, manifest_ref, snapshot_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, project.id, l.id, l.revision, gen, hostGen, now(), insp.path_state, JSON.stringify(stored), manifestRef, snapshot);
    const cur = ctx.db.prepare('SELECT location_generation FROM project_locations WHERE id=?').get(l.id) as { location_generation: number } | undefined;
    if (!cur || cur.location_generation !== gen) return; // path edited mid-inspection: history only
    const identity = identityState(ctx.db, project, l, insp);
    ctx.db.prepare('UPDATE project_locations SET last_inspection_id=?, canonical_path=?, git_root=?, project_subdirectory=?, identity_state=? WHERE id=?')
      .run(id, insp.canonical_path ?? l.canonical_path, insp.git?.root ?? null, insp.git?.subdir ?? null, identity, l.id);
    if (l.id === project.source_location_id && insp.git?.is_repo && !project.repository_identity_json) {
      ctx.db.prepare('UPDATE projects SET repository_identity_json=?, repo_subdirectory=?, updated_at=? WHERE id=?')
        .run(JSON.stringify({ root_commits: insp.git.root_commits, remotes: insp.git.remotes, recorded_at: now() }), insp.git.subdir ?? '', now(), project.id);
    }
  });
  return { id, inspection: insp, snapshot_id: snapshot };
}

function identityState(db: DB, project: ProjectRow, l: LocationRow, insp: Inspection) {
  if (l.identity_state === 'user_confirmed' || l.identity_state === 'content_verified') return l.identity_state;
  if (l.id === project.source_location_id) return insp.path_state === 'exists' ? 'source' : 'unverified';
  const fresh = getProjectRow(db, project.id);
  const ident = fresh.repository_identity_json ? JSON.parse(fresh.repository_identity_json) as { root_commits?: string[] } : null;
  if (!insp.git?.is_repo || !ident?.root_commits?.length) return 'unverified';
  return insp.git.root_commits?.some((c) => ident.root_commits!.includes(c)) ? 'verified' : 'mismatch';
}

const summarize = (r: { id: string; inspection: Inspection; snapshot_id: string | null }) => {
  const { manifest, ...rest } = r.inspection;
  return { inspection_id: r.id, snapshot_id: r.snapshot_id, ...rest, manifest: manifest ? { count: manifest.count, digest: manifest.digest, excluded: manifest.excluded } : null };
};

// ---------------- find an existing copy of a project on a host ----------------

/** Package names declared in a local project folder (pubspec.yaml / package.json). */
function localPackageNames(dir: string): string[] {
  const out: string[] = [];
  try { const m = /^name:\s*["']?([A-Za-z0-9_.-]+)/m.exec(readFileSync(join(dir, 'pubspec.yaml'), 'utf8')); if (m) out.push(m[1]); } catch { /* none */ }
  try { const n = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name; if (typeof n === 'string') out.push(n.replace(/^@[^/]+\//, '')); } catch { /* none */ }
  return out;
}

const SAFE_TERM = /^[A-Za-z0-9._ -]{2,100}$/;
const termVariants = (t: string) => [t, t.replace(/[\s-]+/g, '_'), t.replace(/[\s_]+/g, '-'), t.replace(/[\s_-]+/g, '')];

/**
 * Searches a host for folders that look like this project: same folder name as the source, same
 * project name, or a pubspec.yaml/package.json declaring the same package name. Candidates are
 * then checked against the project's Git identity (root commits). Read-only and bounded.
 */
export async function findProjectOnHost(ctx: Ctx, raw: unknown) {
  const input = z.object({
    host_id: z.uuid(), project_id: z.uuid().optional(), name: z.string().max(100).optional(),
    source_path: z.string().max(4096).optional(), search_root: z.string().max(4096).default('~'), max_depth: z.number().int().min(1).max(8).default(5),
  }).strict().parse(raw);
  const host = getHostRow(ctx.db, input.host_id);
  if ((host.observed_os ?? host.declared_os) === 'windows') throw new AppError('PROBE_UNSUPPORTED', 'project search on Windows remote hosts is not supported in v1');
  const root = input.search_root.trim() || '~';
  if (!(root.startsWith('/') || root === '~' || root.startsWith('~/'))) throw new AppError('VALIDATION_ERROR', 'search_root must be absolute or start with ~');

  // --- search terms + identity from what we know locally
  const folderNames = new Set<string>();
  const pkgNames = new Set<string>();
  let identity: string[] = [];
  let sourceDir: string | undefined = input.source_path;
  const bound = new Map<string, string>();
  if (input.project_id) {
    const p = getProjectRow(ctx.db, input.project_id);
    folderNames.add(p.name);
    const src = p.source_location_id ? getLocationRow(ctx.db, p.source_location_id) : null;
    if (src && !src.host_id) sourceDir ??= src.path_input ?? undefined;
    identity = p.repository_identity_json ? JSON.parse(p.repository_identity_json).root_commits ?? [] : [];
    for (const l of ctx.db.prepare('SELECT id, canonical_path FROM project_locations WHERE project_id=? AND host_id=? AND canonical_path IS NOT NULL').all(p.id, host.id) as { id: string; canonical_path: string }[]) bound.set(l.canonical_path, l.id);
  }
  if (input.name) folderNames.add(input.name);
  if (sourceDir) {
    folderNames.add(win32.basename(sourceDir));
    for (const n of localPackageNames(sourceDir)) { pkgNames.add(n); folderNames.add(n); }
    if (!identity.length) {
      const g = await run(splitCommand(getSettings(ctx.db).git_path), ['rev-list', '--max-parents=0', 'HEAD'], { cwd: sourceDir, timeoutMs: 15_000 }).catch(() => null);
      if (g?.exit_code === 0) identity = g.stdout.split(/\s+/).filter(Boolean);
    }
  }
  const names = [...new Set([...folderNames].flatMap(termVariants).filter((t) => SAFE_TERM.test(t)))].slice(0, 16);
  const pkgs = [...new Set([...pkgNames].filter((t) => /^[A-Za-z0-9_.-]{2,100}$/.test(t)))].slice(0, 4);
  if (!names.length) throw new AppError('VALIDATION_ERROR', 'nothing to search for: give project_id, name, or source_path');

  // --- one bounded, read-only remote search. Terms are validated above and passed quoted.
  const assign = root === '~' ? 'R="$HOME"' : root.startsWith('~/') ? `R="$HOME"/${posixQuote(root.slice(2))}` : `R=${posixQuote(root)}`;
  const prune = ['Library', '.Trash', 'node_modules', '.git', 'Pods', 'build', '.dart_tool', '.pub-cache', '.npm', '.gradle', 'DerivedData', '.cache', '.cocoapods', '.rbenv', '.nvm']
    .map((n) => `-name ${posixQuote(n)}`).join(' -o ');
  const nameExpr = names.map((n) => `-iname ${posixQuote(n)}`).join(' -o ');
  const pkgRe = pkgs.map((p) => p.replaceAll('.', '\\.')).join('|');
  const script = `${assign}
E=$(mktemp 2>/dev/null || echo /tmp/sshrm-find-$$)
{ find "$R" -maxdepth ${input.max_depth} \\( ${prune} \\) -prune -o -type d \\( ${nameExpr} \\) -print 2>>"$E" | sed 's/^/N\t/'
${pkgs.length ? `  find "$R" -maxdepth ${input.max_depth + 1} \\( ${prune} \\) -prune -o -type f \\( -name pubspec.yaml -o -name package.json \\) -print 2>>"$E" | head -n 5000 | while IFS= read -r f; do grep -qiE ${posixQuote(`^name:[[:space:]]*["']?(${pkgRe})["']?[[:space:]]*$|"name":[[:space:]]*"(@[^/"]*/)?(${pkgRe})"`)} "$f" 2>/dev/null && printf 'P\\t%s\\n' "$(dirname "$f")"; done` : ''}
} | head -n 60 | while IFS="$(printf '\\t')" read -r k d; do
  c=$(git -C "$d" rev-list --max-parents=0 HEAD 2>/dev/null | tr '\\n' ' '); m=""; [ -f "$d/pubspec.yaml" ] && m="pubspec"; [ -f "$d/package.json" ] && m="$m package"
  printf '@@C %s\\t%s\\t%s\\t%s\\t%s\\n' "$k" "$(cd "$d" 2>/dev/null && pwd -P || echo "$d")" "$c" "$m" "$(stat -f %Sm -t %Y-%m-%d "$d" 2>/dev/null || date -r "$d" +%Y-%m-%d 2>/dev/null)"
done
grep -i 'not permitted' "$E" 2>/dev/null | head -n 5 | sed 's/^/@@BLOCKED /'; rm -f "$E"; echo @@END`;
  const r = await sshRun(ctx, host, script, getSettings(ctx.db).inspect_timeout_s, { maxBytes: 1 << 20 });
  if (!r.stdout.includes('@@END')) {
    const c = classify(r);
    throw new AppError(c.code, c.message, { details: { host_id: host.id, diagnostics: diagnostics(r) }, next_action: c.next_action });
  }
  const byPath = new Map<string, { path: string; matched_by: string[]; git: boolean; same_repository: boolean | null; markers: string[]; modified: string | null; bound_location_id: string | null }>();
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('@@C ')) continue;
    const [k, path, commits, markers, modified] = line.slice(4).replace(/\r$/, '').split('\t');
    const roots = (commits ?? '').split(/\s+/).filter(Boolean);
    const e = byPath.get(path) ?? { path, matched_by: [], git: roots.length > 0, modified: modified || null, markers: (markers ?? '').split(' ').filter(Boolean),
      same_repository: roots.length && identity.length ? roots.some((c) => identity.includes(c)) : null, bound_location_id: bound.get(path) ?? null };
    const why = k === 'P' ? 'package_name' : 'folder_name';
    if (!e.matched_by.includes(why)) e.matched_by.push(why);
    byPath.set(path, e);
  }
  const score = (c: { same_repository: boolean | null; matched_by: string[] }) => (c.same_repository === true ? 100 : c.same_repository === false ? -100 : 0) + (c.matched_by.includes('package_name') ? 10 : 0) + c.matched_by.length;
  const candidates = [...byPath.values()].sort((a, b) => score(b) - score(a));
  const blocked = [...r.stdout.matchAll(/^@@BLOCKED (.+)$/gm)].map((m) => m[1].trim());
  return {
    host_id: host.id, search_root: root, max_depth: input.max_depth, searched_for: { folder_names: names, package_names: pkgs, git_root_commits: identity.slice(0, 3) },
    candidates,
    ...(blocked.length ? { blocked_folders: blocked, note: 'Some folders were not searchable (macOS privacy). A copy inside ~/Documents, ~/Desktop or ~/Downloads would be missed; ask the user to enable "Allow full disk access for remote users".' } : {}),
    guidance: candidates.length
      ? 'same_repository=true is strong evidence. A name/package match alone is a hint: confirm with the user, then bind it (adopt_existing) and run preflight. Never pick a same_repository=false folder.'
      : 'No existing copy found. Ask the user where it should live (or whether it is somewhere not searched) before creating a new folder.',
  };
}

export async function inspectProject(ctx: Ctx, raw: unknown) {
  const input = z.object({ project_id: z.uuid(), location_ids: z.array(z.uuid()).max(10).optional() }).strict().parse(raw);
  const project = getProjectRow(ctx.db, input.project_id);
  const locs = (ctx.db.prepare('SELECT * FROM project_locations WHERE project_id=?').all(project.id) as LocationRow[])
    .filter((l) => !input.location_ids || input.location_ids.includes(l.id));
  // source first so the repository identity exists before destinations are compared
  locs.sort((a, b) => (a.id === project.source_location_id ? -1 : b.id === project.source_location_id ? 1 : 0));
  const results = [];
  for (const l of locs) results.push({ location_id: l.id, ...summarize(await inspectLocation(ctx, project, l)) });
  return { project_id: project.id, inspected_at: now(), results, note: 'Read-only. No fetch, pull, checkout, mkdir or writes were performed.' };
}

// ---------------- preflight / verify ----------------

type Fact = { kind: string; blocking: boolean; detail: string; paths?: string[] };
const VERDICT_ORDER = ['path_unset', 'path_missing', 'unsupported_layout', 'wrong_repository', 'conflicts_present', 'source_changed', 'destination_dirty',
  'branch_mismatch', 'revision_mismatch', 'identity_unverified', 'content_mismatch', 'needs_recheck'];

function overlapFacts(db: DB, l: LocationRow, canonical: string | undefined, home?: string): Fact[] {
  if (!canonical) return [];
  const facts: Fact[] = [];
  const norm = (p: string) => (l.path_flavor === 'windows' ? p.replaceAll('\\', '/').toLowerCase() : p).replace(/\/+$/, '');
  const c = norm(canonical);
  if (c === '' || c === '/' || (home && c === norm(home)) || /^[a-z]:$/.test(c)) facts.push({ kind: 'unsupported_layout', blocking: true, detail: `destination is a filesystem/home root (${canonical})` });
  const others = db.prepare('SELECT id, canonical_path FROM project_locations WHERE id<>? AND canonical_path IS NOT NULL AND ((host_id IS NULL AND ? IS NULL) OR host_id=?)')
    .all(l.id, l.host_id, l.host_id) as { id: string; canonical_path: string }[];
  for (const o of others) {
    const oc = norm(o.canonical_path);
    if (oc === c || oc.startsWith(c + '/') || c.startsWith(oc + '/')) facts.push({ kind: 'unsupported_layout', blocking: true, detail: `overlaps location ${o.id} (${o.canonical_path})` });
  }
  return facts;
}

const readManifest = (db: DB, inspectionId: string): Entry[] => {
  const r = db.prepare('SELECT manifest_ref FROM inspections WHERE id=?').get(inspectionId) as { manifest_ref: string | null } | undefined;
  return r?.manifest_ref ? JSON.parse(readFileSync(r.manifest_ref, 'utf8')) : [];
};

function compare(db: DB, project: ProjectRow, dest: LocationRow, src: Inspection, dst: Inspection, policy: ConsistencyPolicy) {
  const facts: Fact[] = [];
  const add = (kind: string, detail: string, paths?: string[], blocking = true) => facts.push({ kind, blocking, detail, ...(paths ? { paths: paths.slice(0, 50) } : {}) });
  const diff = { missing: [] as string[], changed: [] as string[], extra_owned: [] as string[], extra_unknown: [] as string[], filtered_only: [] as string[] };
  if (dst.path_state === 'unset') { add('path_unset', 'destination path is not set'); return { facts, diff }; }
  if (src.path_state !== 'exists') { add('path_missing', `source path state: ${src.path_state}`); return { facts, diff }; }
  if (dst.error) { add('needs_recheck', `${dst.error.code}: ${dst.error.message}`); return { facts, diff }; }
  if (dst.path_state === 'missing') { add('path_missing', dest.mode === 'create_if_missing' ? 'destination does not exist; create it explicitly (agent plan)' : 'destination does not exist (adopt_existing)'); return { facts, diff }; }
  if (dst.path_state !== 'exists') { add('unsupported_layout', `destination path state: ${dst.path_state}`); return { facts, diff }; }
  facts.push(...overlapFacts(db, dest, dst.canonical_path, dst.home));
  for (const i of [...src.layout_issues.map((x) => `source ${x}`), ...dst.layout_issues.map((x) => `destination ${x}`)]) add('unsupported_layout', i);
  if (!src.manifest || !dst.manifest) return { facts, diff };
  if (!src.stable) add('source_changed', 'source changed while it was being read; retry');
  const sg = src.git;
  const dg = dst.git;
  if (sg?.is_repo && dg?.is_repo) {
    const ident = project.repository_identity_json ? JSON.parse(project.repository_identity_json).root_commits as string[] : sg.root_commits ?? [];
    if (dest.identity_state !== 'user_confirmed' && ident.length && dg.root_commits?.length && !dg.root_commits.some((c) => ident.includes(c))) {
      add('wrong_repository', 'destination repository shares no root commit with the project; a similar folder name or URL is not proof of identity');
    }
    if ((sg.subdir ?? '') !== (dg.subdir ?? '')) add('unsupported_layout', `subdirectory differs: source '${sg.subdir}' vs destination '${dg.subdir}'`);
    if (sg.conflicts || dg.conflicts) add('conflicts_present', `unmerged entries: source ${sg.conflicts}, destination ${dg.conflicts}`);
    if (sg.branch !== dg.branch) {
      const detached = !dg.branch || !sg.branch;
      add('branch_mismatch', `source ${sg.branch ?? '(detached)'} vs destination ${dg.branch ?? '(detached)'}`, undefined,
        detached ? !policy.allow_detached || sg.head !== dg.head : policy.require_same_branch);
    }
    if (sg.head !== dg.head) add('revision_mismatch', `source ${sg.head?.slice(0, 12)} vs destination ${dg.head?.slice(0, 12)}`);
  } else if (sg?.is_repo && !dg?.is_repo) {
    if (policy.mode === 'git_state') add('unsupported_layout', `destination is not a Git repository (git ${dg?.available ? 'installed' : 'not installed'}); git_state policy cannot be met`);
    else if (dest.identity_state !== 'user_confirmed' && dest.identity_state !== 'content_verified') add('identity_unverified', 'destination has no Git metadata; identity rests on content match only', undefined, false);
  }
  // content
  const sm = new Map(src.manifest!.entries.map((e) => [e.p, e]));
  const dm = new Map(dst.manifest!.entries.map((e) => [e.p, e]));
  const owned = new Set<string>();
  if (dest.last_verified_sync_id) {
    const v = db.prepare('SELECT evidence_json FROM sync_verifications WHERE id=?').get(dest.last_verified_sync_id) as { evidence_json: string } | undefined;
    const ref = v ? JSON.parse(v.evidence_json).source_inspection_id : null;
    if (ref) for (const e of readManifest(db, ref)) owned.add(e.p);
  }
  // A non-Git destination is listed with the non-Git exclusions (build/, node_modules/...). Source files
  // in those paths (e.g. a committed build report) can never be compared there: report, don't block.
  const outOfScope = sg?.is_repo && !dg?.is_repo ? [...sm.keys()].filter((p) => NON_GIT_EXCLUDES.some((g) => matchesGlob(p, g))) : [];
  if (outOfScope.length) add('scope_difference', `${outOfScope.length} tracked source file(s) are in paths a non-Git destination excludes; not compared`, outOfScope, false);
  for (const p of outOfScope) sm.delete(p);
  for (const [p, e] of sm) {
    const d = dm.get(p);
    if (!d) diff.missing.push(p);
    else if (d.t !== e.t || (e.g && d.g ? d.g !== e.g : d.h !== e.h)) diff.changed.push(p);
    else if (d.h !== e.h) diff.filtered_only.push(p);
  }
  for (const p of dm.keys()) if (!sm.has(p) && !policy.exclusions.some((g) => matchesGlob(p, g))) (owned.has(p) ? diff.extra_owned : diff.extra_unknown).push(p);
  if (diff.filtered_only.length) {
    add('filter_only_differences', `${diff.filtered_only.length} file(s) differ only in bytes Git normalises (line endings / clean filters); compared by Git blob id, same content`, diff.filtered_only, false);
  }
  const destDirtyAtRisk = (dg?.dirty_paths ?? []).filter((p) => diff.changed.includes(p) || diff.extra_unknown.includes(p));
  if (destDirtyAtRisk.length) add('destination_dirty', 'destination has uncommitted/untracked work that differs from source; it would be overwritten', destDirtyAtRisk);
  if (diff.missing.length || diff.changed.length || diff.extra_owned.length || diff.extra_unknown.length) {
    add('content_mismatch', `missing ${diff.missing.length}, changed ${diff.changed.length}, stale-owned ${diff.extra_owned.length}, unknown extra ${diff.extra_unknown.length}`,
      [...diff.changed, ...diff.missing, ...diff.extra_owned, ...diff.extra_unknown]);
  }
  return { facts, diff };
}

function verdictOf(facts: Fact[]) {
  const blocking = facts.filter((f) => f.blocking).map((f) => f.kind);
  return VERDICT_ORDER.find((v) => blocking.includes(v)) ?? 'ready';
}

function suggestPlan(verdict: string, src: Inspection, dst: Inspection, dest: LocationRow, diff: ReturnType<typeof compare>['diff']) {
  const root = dst.canonical_path ?? dest.path_input ?? '<path>';
  const steps: string[] = [];
  switch (verdict) {
    case 'ready': return { kind: 'none', steps: ['Run your build/test from the verified path; re-run preflight before the next build.'] };
    case 'path_unset': return { kind: 'set_path', steps: ['Ask the user for the destination path, then update_project_location. Do not invent one.'] };
    case 'path_missing': return dest.mode === 'create_if_missing'
      ? { kind: 'create_then_transfer', steps: [`With the user's explicit choice: mkdir -p ${posixQuote(root)} via ssh`, 'Transfer the source scope', 'verify_project_sync'] }
      : { kind: 'fix_path', steps: ['The adopted path does not exist. Ask the user for the correct existing path, or switch mode to create_if_missing explicitly.'] };
    case 'wrong_repository': return { kind: 'rebind', steps: ['Do not modify this folder. Ask the user for the correct checkout path, or confirm identity explicitly if this really is a fork (update_project_location confirm_identity).'] };
    case 'conflicts_present': return { kind: 'manual', steps: ['Resolve merge conflicts with the user. Never reset, clean, or checkout --force automatically.'] };
    case 'destination_dirty': return { kind: 'preserve_work', steps: ['Show the user the destination diff (git -C <path> status / diff).', 'Options: commit/push it from there, copy it aside, or choose another worktree. Never stash/reset/clean silently.'] };
    case 'branch_mismatch': return { kind: 'choose_checkout', steps: ['Prefer another existing checkout/worktree on the right branch, or (if destination is clean and the user agrees) git switch <branch> there. Do not force a branch to match names.'] };
    case 'revision_mismatch': steps.push(
      `Move commits without a cloud remote: on source 'git bundle create sync.bundle ${dst.git?.head ? `${dst.git.head.slice(0, 12)}..` : ''}${src.git?.branch ?? 'HEAD'}', scp it, then on destination 'git fetch sync.bundle ${src.git?.branch ?? 'HEAD'}' and 'git merge --ff-only FETCH_HEAD'.`,
      'If --ff-only fails the destination is ahead/diverged: stop and ask the user.');
      // falls through to content plan
    // eslint-disable-next-line no-fallthrough
    case 'content_mismatch':
    case 'identity_unverified':
      return {
        kind: 'incremental_transfer',
        copy: [...diff.changed, ...diff.missing].slice(0, 200), copy_count: diff.changed.length + diff.missing.length,
        delete_owned_stale: diff.extra_owned.slice(0, 200), unknown_destination_files: diff.extra_unknown.slice(0, 200),
        steps: [...steps, 'acquire_project_lease', 'Copy only the listed files (scp per file or an archive of them); no rsync --delete, never copy .git.',
          diff.extra_owned.length ? 'Delete the stale-owned files listed (they were synced before and no longer exist in source).' : '',
          diff.extra_unknown.length ? 'Unknown destination files were not created by sync: ask the user, add an exclusion, or remove them deliberately. They block ready.' : '',
          'verify_project_sync with the expected_source_snapshot, then release_project_lease'].filter(Boolean),
      };
    default: return { kind: 'manual', steps: ['Inspect facts and resolve with the user.'] };
  }
}

function locationsFor(db: DB, projectId: string, destinationId: string) {
  const project = getProjectRow(db, projectId);
  if (!project.source_location_id) throw new AppError('VALIDATION_ERROR', 'project has no source location');
  const dest = getLocationRow(db, destinationId);
  if (dest.project_id !== project.id) throw new AppError('VALIDATION_ERROR', 'location belongs to another project');
  if (dest.id === project.source_location_id) throw new AppError('VALIDATION_ERROR', 'destination equals source');
  return { project, src: getLocationRow(db, project.source_location_id), dest };
}

function leaseInfo(db: DB, locationId: string) {
  return db.prepare('SELECT owner, operation_id, expires_at FROM project_operation_leases WHERE destination_location_id=? AND expires_at>?').get(locationId, now()) ?? null;
}

export async function preflightProject(ctx: Ctx, raw: unknown) {
  const input = z.object({ project_id: z.uuid(), destination_location_id: z.uuid(), expected_source_snapshot: z.string().optional(), intent: z.enum(['build', 'run', 'test', 'transfer', 'inspect']).default('build') }).strict().parse(raw);
  const { project, src, dest } = locationsFor(ctx.db, input.project_id, input.destination_location_id);
  const s = await inspectLocation(ctx, project, src);
  const d = await inspectLocation(ctx, getProjectRow(ctx.db, project.id), dest);
  const policy = policyOf(dest);
  const { facts, diff } = compare(ctx.db, getProjectRow(ctx.db, project.id), getLocationRow(ctx.db, dest.id), s.inspection, d.inspection, policy);
  if (input.expected_source_snapshot && input.expected_source_snapshot !== s.snapshot_id) facts.push({ kind: 'source_changed', blocking: true, detail: `source snapshot is now ${s.snapshot_id}, expected ${input.expected_source_snapshot}` });
  const lease = leaseInfo(ctx.db, dest.id);
  if (lease) facts.push({ kind: 'lease_held', blocking: false, detail: `an operation lease is held: ${JSON.stringify(lease)}` });
  const verdict = verdictOf(facts);
  const t = now();
  return {
    verdict, intent: input.intent, facts, source_snapshot: s.snapshot_id, destination_snapshot: d.snapshot_id,
    generations: { source: src.location_generation, destination: dest.location_generation },
    evidence_refs: { source_inspection_id: s.id, destination_inspection_id: d.id }, evaluated_at: t,
    ready_until: verdict === 'ready' ? new Date(Date.now() + policy.readiness_max_age_seconds * 1000).toISOString() : null,
    suggested_plan: suggestPlan(verdict, s.inspection, d.inspection, dest, diff),
    source: summarize(s), destination: summarize(d),
    note: 'Readiness is evidence at a point in time, not a lock. External edits after this check are not prevented.',
  };
}

export async function verifyProjectSync(ctx: Ctx, raw: unknown) {
  const input = z.object({ project_id: z.uuid(), destination_location_id: z.uuid(), expected_source_snapshot: z.string().min(5), operation_id: z.string().min(1).max(200),
    expected_generations: z.object({ source: z.number().int(), destination: z.number().int() }), transfer_mode: z.string().max(50).optional() }).strict().parse(raw);
  const { project, src, dest } = locationsFor(ctx.db, input.project_id, input.destination_location_id);
  const id = randomUUID();
  const started = now();
  const record = (outcome: 'verified' | 'failed' | 'partial' | 'needs_recheck', evidence: object) => tx(ctx.db, () => {
    ctx.db.prepare(`INSERT INTO sync_verifications(id, project_id, source_location_id, destination_location_id, generations_json, expected_source_snapshot, transfer_mode, policy_version, evidence_json, started_at, verified_at, outcome, operation_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, project.id, src.id, dest.id, JSON.stringify(input.expected_generations), input.expected_source_snapshot, input.transfer_mode ?? null,
      sha(dest.consistency_policy_json).slice(0, 12), JSON.stringify(evidence), started, outcome === 'verified' ? now() : null, outcome, input.operation_id);
    const cur = getLocationRow(ctx.db, dest.id);
    if (outcome === 'verified' && cur.location_generation === input.expected_generations.destination) {
      // A destination without Git that matched the source byte-for-byte has proven its identity by content.
      ctx.db.prepare(`UPDATE project_locations SET last_verified_sync_id=?, identity_state=CASE WHEN identity_state='unverified' THEN 'content_verified' ELSE identity_state END WHERE id=?`).run(id, dest.id);
    }
    return outcome;
  });
  if (src.location_generation !== input.expected_generations.source || dest.location_generation !== input.expected_generations.destination) {
    record('needs_recheck', { reason: 'location generations changed (path/policy/host edited)' });
    return { verification_id: id, outcome: 'needs_recheck', reason: 'location generations changed since preflight; run preflight again' };
  }
  const s = await inspectLocation(ctx, project, src);
  if (s.snapshot_id !== input.expected_source_snapshot || !s.inspection.stable) {
    record('needs_recheck', { reason: 'source_changed', source_snapshot: s.snapshot_id, source_inspection_id: s.id });
    return { verification_id: id, outcome: 'needs_recheck', reason: 'source changed after preflight; the transferred content may be stale', source_snapshot: s.snapshot_id };
  }
  const d = await inspectLocation(ctx, project, dest);
  const { facts, diff } = compare(ctx.db, getProjectRow(ctx.db, project.id), getLocationRow(ctx.db, dest.id), s.inspection, d.inspection, policyOf(dest));
  const verdict = verdictOf(facts);
  const matched = s.inspection.manifest!.count - diff.missing.length - diff.changed.length;
  const outcome = verdict === 'ready' ? 'verified' : d.inspection.error ? 'needs_recheck' : matched > 0 && matched < s.inspection.manifest!.count ? 'partial' : 'failed';
  record(outcome, { source_inspection_id: s.id, destination_inspection_id: d.id, verdict, facts: facts.slice(0, 20) });
  return { verification_id: id, outcome, verdict, facts, source_snapshot: s.snapshot_id, destination_snapshot: d.snapshot_id,
    note: outcome === 'verified' ? 'Verified by the manager reading both sides; agent claims were not used as evidence.' : 'Not verified. Do not build from this destination yet.' };
}

// ---------------- leases ----------------

export function acquireLease(ctx: Ctx, raw: unknown) {
  const input = z.object({ location_id: z.uuid(), operation_id: z.string().min(1).max(200), owner: z.string().min(1).max(200), ttl_seconds: z.number().int().min(10).max(900).default(120) }).strict().parse(raw);
  return tx(ctx.db, () => {
    getLocationRow(ctx.db, input.location_id);
    const t = now();
    ctx.db.prepare('DELETE FROM project_operation_leases WHERE expires_at<=?').run(t);
    const cur = ctx.db.prepare('SELECT * FROM project_operation_leases WHERE destination_location_id=?').get(input.location_id) as { owner: string; operation_id: string; expires_at: string } | undefined;
    if (cur && (cur.owner !== input.owner || cur.operation_id !== input.operation_id)) {
      throw new AppError('LEASE_HELD', 'another operation holds this location', { retryable: true, details: { holder: cur } });
    }
    const exp = new Date(Date.now() + input.ttl_seconds * 1000).toISOString();
    ctx.db.prepare(`INSERT INTO project_operation_leases(destination_location_id, owner, operation_id, expires_at, heartbeat_at) VALUES(?,?,?,?,?)
      ON CONFLICT(destination_location_id) DO UPDATE SET expires_at=excluded.expires_at, heartbeat_at=excluded.heartbeat_at`).run(input.location_id, input.owner, input.operation_id, exp, t);
    const l = getLocationRow(ctx.db, input.location_id);
    return { location_id: l.id, operation_id: input.operation_id, expires_at: exp, location_generation: l.location_generation,
      note: 'Coordination only: not a filesystem lock. Verify after transfer.' };
  });
}

export function releaseLease(ctx: Ctx, raw: unknown) {
  const input = z.object({ location_id: z.uuid(), operation_id: z.string().min(1), owner: z.string().min(1) }).strict().parse(raw);
  const r = ctx.db.prepare('DELETE FROM project_operation_leases WHERE destination_location_id=? AND operation_id=? AND owner=?').run(input.location_id, input.operation_id, input.owner);
  return { released: Number(r.changes) > 0 };
}
