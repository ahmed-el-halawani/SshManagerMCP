import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { approveHostKey, checkHost, connectionRecipe, listRemoteDir, probeCapabilities, type Ctx } from './checks.ts';
import { openDb, now, tx } from './db.ts';
import { AppError } from './errors.ts';
import { switchToKeyAuth } from './keyauth.ts';
import { sshAlias, writeSshConfig } from './sshconfig.ts';
import { getHost, listHosts, registerHost, removeHost, updateHost, profileOf, type HostRow } from './hosts.ts';
import { parseConnectionInput, type ShellKind } from './parse.ts';
import { executionEnvironment, resolveDataDir } from './paths.ts';
import * as projects from './projects.ts';
import { Profile, type Source } from './schemas.ts';
import { clearHostPassword, setHostPassword, writeAskpass } from './secrets.ts';
import * as signing from './signing.ts';
import { getSettings, setSettings, type Settings } from './settings.ts';
import { knownHostsPath } from './ssh.ts';

export { AppError } from './errors.ts';
export { resolveDataDir } from './paths.ts';

export function createLogger(dataDir: string, name: string) {
  const file = join(dataDir, 'logs', `${name}.log`);
  return (level: string, msg: string, extra?: unknown) => {
    try {
      if (existsSync(file) && statSync(file).size > 5 << 20) renameSync(file, file + '.1'); // ponytail: one rotated file
      appendFileSync(file, `${now()} ${level} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`);
    } catch { /* logging must never break a request */ }
  };
}

const EXPORT_VERSION = 1;

export function createCore(opts: { dataDir?: string; source: Source }) {
  const dataDir = opts.dataDir ?? resolveDataDir();
  for (const d of ['logs', 'manifests']) mkdirSync(join(dataDir, d), { recursive: true });
  const db = openDb(dataDir);
  if (process.platform === 'win32') { writeAskpass(dataDir); signing.writeRunnerShim(dataDir); }
  const ctx: Ctx = { db, dataDir, source: opts.source };
  const s = opts.source;
  /** Host changes also refresh <data-dir>\ssh_config, so `ssh <alias>` always matches the registry. */
  const syncConfig = <T>(r: T) => { writeSshConfig(db, dataDir); return r; };
  syncConfig(null);
  return {
    dataDir, db, ctx,
    close: () => db.close(),
    // hosts
    parseConnectionInput: (i: { text: string; source_shell: ShellKind }) =>
      parseConnectionInput(z.string().max(2000).parse(i.text), z.enum(['posix', 'powershell', 'cmd']).parse(i.source_shell)),
    registerHost: (i: unknown) => syncConfig(registerHost(db, s, i)),
    updateHost: (i: unknown) => syncConfig(updateHost(db, s, i)),
    listHosts: (i: Parameters<typeof listHosts>[1] = {}) => listHosts(db, i),
    getHost: (i: { host_id: string }) => { const id = z.uuid().parse(i.host_id); return { ...getHost(db, id), ssh_alias: sshAlias(db, dataDir, id) }; },
    removeHost: (i: unknown) => syncConfig(removeHost(db, s, i)),
    checkHost: (i: unknown) => checkHost(ctx, i),
    probeCapabilities: (i: unknown) => probeCapabilities(ctx, i),
    approveHostKey: (i: unknown) => approveHostKey(ctx, i),
    connectionRecipe: (i: unknown) => connectionRecipe(ctx, i),
    listRemoteDir: (i: unknown) => listRemoteDir(ctx, i),
    // GUI-only: the MCP server deliberately exposes no way to send or read a password.
    setHostPassword: (i: { host_id: string; password: string }) => setHostPassword(db, z.uuid().parse(i.host_id), z.string().parse(i.password)),
    clearHostPassword: (i: { host_id: string }) => clearHostPassword(db, z.uuid().parse(i.host_id)),
    switchToKeyAuth: (i: unknown) => switchToKeyAuth(ctx, i),
    // code signing over SSH: the mode is the user's choice (GUI only); setup may also be triggered by an agent once the mode is set
    setSigningMode: (i: unknown) => signing.setSigningMode(ctx, i),
    setupBuildKeychain: (i: unknown) => signing.setupBuildKeychain(ctx, i),
    checkSigning: (i: unknown) => signing.checkSigning(ctx, i),
    hostHistory: (i: { host_id: string; limit?: number }) => ({
      checks: (db.prepare('SELECT * FROM checks WHERE host_id=? ORDER BY started_at DESC LIMIT ?').all(z.uuid().parse(i.host_id), Math.min(i.limit ?? 20, 100)) as Record<string, unknown>[])
        .map((c) => ({ ...c, diagnostics: c.diagnostics_json ? JSON.parse(c.diagnostics_json as string) : null, diagnostics_json: undefined })),
    }),
    // projects
    registerProject: (i: unknown) => projects.registerProject(ctx, i),
    listProjects: (i: Parameters<typeof projects.listProjects>[1] = {}) => projects.listProjects(db, i),
    getProject: (i: { project_id: string }) => projects.getProject(db, z.uuid().parse(i.project_id)),
    removeProject: (i: unknown) => projects.removeProject(ctx, i),
    bindProjectLocation: (i: unknown) => projects.bindProjectLocation(ctx, i),
    updateProjectLocation: (i: unknown) => projects.updateProjectLocation(ctx, i),
    unbindProjectLocation: (i: unknown) => projects.unbindProjectLocation(ctx, i),
    inspectProject: (i: unknown) => projects.inspectProject(ctx, i),
    findProjectOnHost: (i: unknown) => projects.findProjectOnHost(ctx, i),
    preflightProject: (i: unknown) => projects.preflightProject(ctx, i),
    verifyProjectSync: (i: unknown) => projects.verifyProjectSync(ctx, i),
    acquireLease: (i: unknown) => projects.acquireLease(ctx, i),
    releaseLease: (i: unknown) => projects.releaseLease(ctx, i),
    // setup
    getSettings: () => getSettings(db),
    setSettings: (p: Partial<Settings>) => setSettings(db, p),
    environment: () => ({ execution_environment: executionEnvironment(), data_dir: dataDir, known_hosts: knownHostsPath(dataDir), platform: process.platform }),
    exportData: () => exportData(ctx),
    previewImport: (doc: unknown) => previewImport(ctx, doc),
    applyImport: (doc: unknown, idempotencyKey: string) => syncConfig(applyImport(ctx, doc, idempotencyKey)),
    backup: (dest: string) => { db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`); return { backup: dest }; },
  };
}
export type Core = ReturnType<typeof createCore>;

// ---- export / import (metadata only; never keys, trust approvals, diagnostics) ----

function exportData(ctx: Ctx) {
  const hosts = (ctx.db.prepare('SELECT * FROM hosts ORDER BY name').all() as HostRow[]).map((h) => {
    const full = getHost(ctx.db, h.id);
    return { export_id: h.id, profile: profileOf(h), metadata: { name: h.name, enabled: !!h.enabled, declared_os: h.declared_os, description: h.description,
      instructions: h.instructions, tags: JSON.parse(h.tags_json), default_remote_directory: h.default_remote_directory },
      capabilities: full.capabilities.map((c) => ({ key: c.key, label: c.label, declared_description: c.declared_description, enabled: c.enabled })) };
  });
  const projs = projects.listProjects(ctx.db).projects.map((p) => ({
    name: p.name, description: p.description,
    locations: p.locations.filter((l) => l.role === 'execution' || l.id === p.source_location_id).map((l) => ({ role: l.role, host_export_id: l.host_id, path: l.path_input, mode: l.mode, label: l.label, policy: l.policy,
      source_path: l.source_location_id && l.source_location_id !== p.source_location_id ? p.locations.find((x) => x.id === l.source_location_id)?.path_input ?? null : null,
      path_note: 'Machine-specific reference from the exporting PC; review after import.' })),
  }));
  return { format: 'ssh-resource-manager-export', version: EXPORT_VERSION, exported_at: now(), hosts, projects: projs };
}

const ImportDoc = z.object({
  format: z.literal('ssh-resource-manager-export'), version: z.literal(EXPORT_VERSION),
  hosts: z.array(z.object({ export_id: z.string(), profile: Profile, metadata: z.record(z.string(), z.unknown()), capabilities: z.array(z.unknown()) })).max(1000),
  projects: z.array(z.object({ name: z.string(), description: z.string(), locations: z.array(z.object({ role: z.enum(['source', 'execution']), host_export_id: z.string().nullable(),
    path: z.string().nullable(), mode: z.enum(['adopt_existing', 'create_if_missing']), label: z.string(), policy: z.unknown(), source_path: z.string().nullable().optional() })) })).max(1000),
}).passthrough();

function previewImport(ctx: Ctx, raw: unknown) {
  const doc = ImportDoc.parse(raw);
  const existing = listHosts(ctx.db, { limit: 100 }).hosts;
  return {
    hosts: doc.hosts.map((h) => ({ name: h.metadata.name, target: h.profile.mode === 'direct' ? `${h.profile.username}@${h.profile.hostname}:${h.profile.port}` : `alias:${h.profile.alias}`,
      duplicates: existing.filter((e) => e.name === h.metadata.name || e.target.includes(h.profile.mode === 'direct' ? h.profile.hostname : h.profile.alias)).map((e) => e.id) })),
    projects: doc.projects.map((p) => ({ name: p.name, locations: p.locations.length })),
    note: 'Import creates new records (no merge), runs no network probes, and imports no trust approvals. Locations start unverified.',
  };
}

function applyImport(ctx: Ctx, raw: unknown, key: string) {
  const doc = ImportDoc.parse(raw);
  const idMap = new Map<string, string>();
  for (const [i, h] of doc.hosts.entries()) {
    const r = registerHost(ctx.db, ctx.source, { profile: h.profile, metadata: h.metadata, capabilities: h.capabilities, idempotency_key: `${key}:h${i}` });
    idMap.set(h.export_id, r.host.id);
  }
  for (const [i, p] of doc.projects.entries()) {
    const src = p.locations.find((l) => l.role === 'source');
    if (!src) continue;
    const loc = (l: (typeof p.locations)[number]) => ({ host_id: l.host_export_id ? idMap.get(l.host_export_id) ?? null : null, path: l.path, mode: l.mode, label: l.label, policy: l.policy as object });
    const created = projects.registerProject(ctx, { name: p.name, description: p.description, source_location: loc(src), idempotency_key: `${key}:p${i}` });
    let rev = created.project.revision;
    for (const [j, l] of p.locations.filter((x) => x.role === 'execution').entries()) {
      if (l.host_export_id && !idMap.has(l.host_export_id)) continue;
      projects.bindProjectLocation(ctx, { project_id: created.project.id, expected_project_revision: rev++, idempotency_key: `${key}:p${i}l${j}`, ...loc(l), ...(l.source_path ? { source_path: l.source_path } : {}) });
    }
  }
  tx(ctx.db, () => ctx.db.prepare("INSERT INTO audit_events(timestamp, source, action, details_json) VALUES(?,?,'import',?)").run(now(), ctx.source, JSON.stringify({ hosts: doc.hosts.length, projects: doc.projects.length })));
  return { imported_hosts: doc.hosts.length, imported_projects: doc.projects.length };
}

export function errorPayload(e: unknown) {
  if (e instanceof AppError) return e.toJSON();
  if (e instanceof z.ZodError) return { code: 'VALIDATION_ERROR', message: 'invalid input', retryable: false, issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  return { code: 'INTERNAL_ERROR', message: String((e as Error)?.message ?? e).slice(0, 500), retryable: false };
}
