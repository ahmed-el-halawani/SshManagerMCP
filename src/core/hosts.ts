import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type DB, now, tx } from './db.ts';
import { AppError, notFound } from './errors.ts';
import { HostPatch, Profile, RegisterHostInput, UpdateHostInput, type Source } from './schemas.ts';
import { getSettings } from './settings.ts';

export type HostRow = {
  id: string; name: string; enabled: number; connection_mode: string; connection_profile_json: string;
  declared_os: string; observed_os: string | null; observed_os_detail: string | null;
  description: string; instructions: string; tags_json: string; default_remote_directory: string | null;
  created_at: string; updated_at: string; revision: number; last_check_id: string | null; identity_generation: number;
  signing_mode: 'off' | 'login_keychain' | 'build_keychain'; signing_state_json: string | null;
};

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function audit(db: DB, source: Source, action: string, hostId: string | null, before: number | null, after: number | null, details: object = {}) {
  db.prepare('INSERT INTO audit_events(timestamp, source, action, host_id, revision_before, revision_after, details_json) VALUES(?,?,?,?,?,?,?)')
    .run(now(), source, action, hostId, before, after, JSON.stringify(details));
}

/** Returns previous result id for a replayed key, or null. Throws on same key with different input. */
export function checkIdempotency(db: DB, key: string, operation: string, input: unknown): string | null {
  const row = db.prepare('SELECT operation, normalized_input_hash, result_reference FROM mutation_requests WHERE idempotency_key=?').get(key) as
    { operation: string; normalized_input_hash: string; result_reference: string } | undefined;
  if (!row) return null;
  if (row.operation !== operation || row.normalized_input_hash !== hash(input)) {
    throw new AppError('IDEMPOTENCY_CONFLICT', 'idempotency_key was already used with different input', { details: { idempotency_key: key } });
  }
  return row.result_reference;
}

export function recordIdempotency(db: DB, key: string, operation: string, input: unknown, ref: string) {
  db.prepare('INSERT INTO mutation_requests(idempotency_key, operation, normalized_input_hash, result_reference, created_at) VALUES(?,?,?,?,?)')
    .run(key, operation, hash(input), ref, now());
}

export function getHostRow(db: DB, id: string): HostRow {
  const row = db.prepare('SELECT * FROM hosts WHERE id=?').get(id) as HostRow | undefined;
  if (!row) throw notFound('host', id);
  return row;
}

export const profileOf = (row: HostRow): Profile => JSON.parse(row.connection_profile_json);

/**
 * Fields that define *which* account/endpoint we talk to. Changing any invalidates trust/check state.
 * How we authenticate to that same account (auth, key file) is not identity: switching password -> key keeps trust and secrets.
 */
const identityKey = (p: Profile) => {
  const { remote_shell_hint: _h, auth: _a, identity_file: _i, identities_only: _o, ...rest } = p as Profile & { remote_shell_hint?: string; identity_file?: string; identities_only?: boolean };
  return JSON.stringify(rest);
};

export function targetSummary(p: Profile): string {
  if (p.mode === 'ssh_alias') return `alias:${p.alias}`;
  const host = p.hostname.includes(':') ? `[${p.hostname}]` : p.hostname;
  return `${p.username}@${host}${p.port === 22 ? '' : `:${p.port}`}${p.proxy_jump?.length ? ` via ${p.proxy_jump.join(',')}` : ''}`;
}

export type HostStatus = {
  state: 'unchecked' | 'checking' | 'reachable' | 'auth_required' | 'trust_required' | 'host_key_changed' | 'unreachable' | 'error' | 'disabled';
  checked_at: string | null; stale: boolean; age_seconds: number | null; error_code: string | null; check_id: string | null;
  warnings: { code: string; message: string; fix: string }[];
};

const STATE_BY_CODE: Record<string, HostStatus['state']> = {
  AUTH_REQUIRED: 'auth_required', TRUST_REQUIRED: 'trust_required', HOST_KEY_CHANGED: 'host_key_changed',
  DNS_FAILED: 'unreachable', CONNECTION_REFUSED: 'unreachable', CONNECTION_TIMEOUT: 'unreachable', NETWORK_UNREACHABLE: 'unreachable',
};

export function hostStatus(db: DB, row: HostRow): HostStatus {
  const lease = db.prepare('SELECT check_id FROM check_leases WHERE host_id=? AND expires_at>?').get(row.id, now()) as { check_id: string } | undefined;
  const check = row.last_check_id
    ? db.prepare('SELECT * FROM checks WHERE id=?').get(row.last_check_id) as { finished_at: string; outcome: string; error_code: string | null; id: string; diagnostics_json: string | null } | undefined
    : undefined;
  const warnings = (check?.diagnostics_json ? JSON.parse(check.diagnostics_json).warnings : undefined) ?? [];
  const ageS = check?.finished_at ? Math.round((Date.now() - Date.parse(check.finished_at)) / 1000) : null;
  const base = {
    checked_at: check?.finished_at ?? null, age_seconds: ageS, error_code: check?.error_code ?? null, check_id: check?.id ?? null, warnings,
    stale: ageS === null || ageS > getSettings(db).stale_after_seconds,
  };
  if (!row.enabled) return { state: 'disabled', ...base };
  if (lease) return { state: 'checking', ...base, check_id: lease.check_id };
  if (!check) return { state: 'unchecked', ...base };
  if (check.outcome === 'success') return { state: 'reachable', ...base };
  return { state: STATE_BY_CODE[check.error_code ?? ''] ?? 'error', ...base };
}

function capabilities(db: DB, hostId: string) {
  return (db.prepare('SELECT * FROM capabilities WHERE host_id=? ORDER BY key').all(hostId) as Record<string, unknown>[]).map((c) => ({
    key: c.key, label: c.label, declared_description: c.declared_description, declaration_source: c.declaration_source,
    enabled: !!c.enabled, observation: c.last_observation_json ? JSON.parse(c.last_observation_json as string) : null, observed_at: c.observed_at,
  }));
}

export function hostSummary(db: DB, row: HostRow) {
  return {
    id: row.id, name: row.name, enabled: !!row.enabled, connection_mode: row.connection_mode,
    target: targetSummary(profileOf(row)), declared_os: row.declared_os, observed_os: row.observed_os,
    os_mismatch: !!row.observed_os && row.declared_os !== 'unknown' && row.observed_os !== row.declared_os,
    tags: JSON.parse(row.tags_json) as string[], revision: row.revision, status: hostStatus(db, row),
    capability_keys: capabilities(db, row.id).filter((c) => c.enabled).map((c) => c.key),
  };
}

export function getHost(db: DB, hostId: string) {
  const row = getHostRow(db, hostId);
  const resources = (db.prepare('SELECT * FROM resources WHERE parent_host_id=? ORDER BY label').all(hostId) as Record<string, unknown>[])
    .map((r) => ({ ...r, declared_metadata: JSON.parse(r.declared_metadata_json as string), declared_metadata_json: undefined }));
  const trust = db.prepare('SELECT target_host, target_port, algorithm, fingerprint, approved_at, source FROM host_trust WHERE host_id=? AND identity_generation=?').all(hostId, row.identity_generation);
  return {
    ...hostSummary(db, row), profile: profileOf(row), description: row.description, instructions: row.instructions,
    observed_os_detail: row.observed_os_detail, default_remote_directory: row.default_remote_directory,
    identity_generation: row.identity_generation, created_at: row.created_at, updated_at: row.updated_at,
    auth: profileOf(row).auth ?? 'key', password_stored: !!db.prepare("SELECT 1 FROM host_secrets WHERE host_id=? AND kind='password'").get(hostId),
    signing: { mode: row.signing_mode, build_keychain: row.signing_state_json ? JSON.parse(row.signing_state_json) : null,
      build_keychain_secret_stored: !!db.prepare("SELECT 1 FROM host_secrets WHERE host_id=? AND kind='build_keychain'").get(hostId) },
    capabilities: capabilities(db, hostId), resources, trust,
  };
}

export function listHosts(db: DB, input: { cursor?: string; limit?: number; query?: string; tag?: string; enabled?: boolean } = {}) {
  const limit = Math.min(input.limit ?? 50, 100);
  const rows = db.prepare('SELECT * FROM hosts WHERE (? IS NULL OR id > ?) ORDER BY id').all(input.cursor ?? null, input.cursor ?? null) as HostRow[];
  const q = input.query?.toLowerCase();
  const filtered = rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || targetSummary(profileOf(r)).toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
    && (!input.tag || (JSON.parse(r.tags_json) as string[]).includes(input.tag))
    && (input.enabled === undefined || !!r.enabled === input.enabled));
  const page = filtered.slice(0, limit);
  return { hosts: page.map((r) => hostSummary(db, r)), next_cursor: filtered.length > limit ? page[page.length - 1].id : null };
}

function duplicates(db: DB, p: Profile, excludeId?: string) {
  const rows = db.prepare('SELECT * FROM hosts').all() as HostRow[];
  return rows.filter((r) => r.id !== excludeId).filter((r) => {
    const o = profileOf(r);
    if (p.mode === 'ssh_alias') return o.mode === 'ssh_alias' && o.alias === p.alias;
    return o.mode === 'direct' && o.hostname.toLowerCase() === p.hostname.toLowerCase() && o.port === p.port && o.username === p.username;
  }).map((r) => ({ id: r.id, name: r.name, target: targetSummary(profileOf(r)) }));
}

function upsertCapabilities(db: DB, hostId: string, caps: z.infer<typeof RegisterHostInput>['capabilities'], source: 'user' | 'agent' | 'import') {
  const stmt = db.prepare(`INSERT INTO capabilities(id, host_id, key, label, declared_description, declaration_source, enabled) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(host_id, key) DO UPDATE SET label=excluded.label, declared_description=excluded.declared_description, enabled=excluded.enabled`);
  for (const c of caps) stmt.run(randomUUID(), hostId, c.key, c.label, c.declared_description, source, c.enabled ? 1 : 0);
}

export function registerHost(db: DB, source: Source, raw: unknown) {
  const input = RegisterHostInput.parse(raw);
  return tx(db, () => {
    const prev = checkIdempotency(db, input.idempotency_key, 'register_host', input);
    if (prev) return { host: getHost(db, prev), duplicate_candidates: duplicates(db, input.profile, prev), replayed: true };
    const id = randomUUID();
    const t = now();
    const m = input.metadata;
    db.prepare(`INSERT INTO hosts(id, name, enabled, connection_mode, connection_profile_json, declared_os, description, instructions, tags_json, default_remote_directory, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, m.name, m.enabled ? 1 : 0, input.profile.mode, JSON.stringify(input.profile), m.declared_os,
      m.description, m.instructions, JSON.stringify(m.tags), m.default_remote_directory ?? null, t, t);
    upsertCapabilities(db, id, input.capabilities, source === 'mcp' ? 'agent' : 'user');
    recordIdempotency(db, input.idempotency_key, 'register_host', input, id);
    audit(db, source, 'register_host', id, null, 1, { target: targetSummary(input.profile) });
    return { host: getHost(db, id), duplicate_candidates: duplicates(db, input.profile, id), replayed: false };
  });
}

export function updateHost(db: DB, source: Source, raw: unknown) {
  const input = UpdateHostInput.parse(raw);
  return tx(db, () => {
    const prev = checkIdempotency(db, input.idempotency_key, 'update_host', input);
    if (prev) return { host: getHost(db, input.host_id), replayed: true };
    const row = getHostRow(db, input.host_id);
    if (row.revision !== input.expected_revision) {
      throw new AppError('REVISION_CONFLICT', `host changed since revision ${input.expected_revision}; reload and review`, {
        details: { host_id: row.id, current_revision: row.revision }, next_action: 'get_host, then reapply your change on the current revision',
      });
    }
    applyPatch(db, row, input.patch, source);
    const rev = row.revision + 1;
    recordIdempotency(db, input.idempotency_key, 'update_host', input, row.id);
    audit(db, source, 'update_host', row.id, row.revision, rev, { fields: Object.keys(input.patch) });
    return { host: getHost(db, row.id), replayed: false };
  });
}

function applyPatch(db: DB, row: HostRow, patch: z.infer<typeof HostPatch>, source: Source) {
  let generation = row.identity_generation;
  let lastCheck = row.last_check_id;
  let profileJson = row.connection_profile_json;
  let observedOs = row.observed_os;
  if (patch.profile) {
    if (identityKey(patch.profile) !== identityKey(profileOf(row))) {
      generation++;
      lastCheck = null;
      observedOs = null;
      // Never send the old endpoint's password to a new endpoint/account.
      db.prepare('DELETE FROM host_secrets WHERE host_id=?').run(row.id);
      db.prepare('UPDATE hosts SET signing_state_json=NULL WHERE id=?').run(row.id); // a build keychain belongs to the old machine
      // Host identity change invalidates every project location bound to it.
      db.prepare('UPDATE project_locations SET location_generation=location_generation+1, identity_state=?, updated_at=? WHERE host_id=?')
        .run('unverified', now(), row.id);
    }
    profileJson = JSON.stringify(patch.profile);
  }
  const m = { name: row.name, enabled: !!row.enabled, declared_os: row.declared_os, description: row.description, instructions: row.instructions,
    tags: JSON.parse(row.tags_json), default_remote_directory: row.default_remote_directory, ...patch.metadata };
  db.prepare(`UPDATE hosts SET name=?, enabled=?, connection_mode=?, connection_profile_json=?, declared_os=?, observed_os=?, description=?, instructions=?,
    tags_json=?, default_remote_directory=?, updated_at=?, revision=revision+1, last_check_id=?, identity_generation=? WHERE id=?`)
    .run(m.name, m.enabled ? 1 : 0, (JSON.parse(profileJson) as Profile).mode, profileJson, m.declared_os, observedOs, m.description, m.instructions,
      JSON.stringify(m.tags), m.default_remote_directory ?? null, now(), lastCheck, generation, row.id);
  if (patch.capabilities) {
    upsertCapabilities(db, row.id, patch.capabilities.upsert, source === 'mcp' ? 'agent' : 'user');
    const del = db.prepare('DELETE FROM capabilities WHERE host_id=? AND key=?');
    for (const k of patch.capabilities.remove) del.run(row.id, k);
  }
  if (patch.resources) {
    const up = db.prepare(`INSERT INTO resources(id, parent_host_id, resource_kind, label, stable_external_id, declared_metadata_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET resource_kind=excluded.resource_kind, label=excluded.label, stable_external_id=excluded.stable_external_id, declared_metadata_json=excluded.declared_metadata_json
      WHERE parent_host_id=excluded.parent_host_id`);
    for (const r of patch.resources.upsert) up.run(r.id ?? randomUUID(), row.id, r.resource_kind, r.label, r.stable_external_id ?? null, JSON.stringify(r.declared_metadata));
    const del = db.prepare('DELETE FROM resources WHERE parent_host_id=? AND id=?');
    for (const id of patch.resources.remove) del.run(row.id, id);
  }
}

export function removeHost(db: DB, source: Source, raw: unknown) {
  const input = z.object({ host_id: z.uuid(), expected_revision: z.number().int() }).strict().parse(raw);
  return tx(db, () => {
    const row = getHostRow(db, input.host_id);
    if (row.revision !== input.expected_revision) {
      throw new AppError('REVISION_CONFLICT', 'host changed; reload before removing', { details: { host_id: row.id, current_revision: row.revision } });
    }
    db.prepare('DELETE FROM hosts WHERE id=?').run(row.id);
    audit(db, source, 'remove_host', row.id, row.revision, null, { name: row.name });
    return { removed: { id: row.id, name: row.name }, note: 'Only the local registry record was removed. Remote data, SSH keys and config files were not touched.' };
  });
}
