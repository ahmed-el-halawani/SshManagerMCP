import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { AppError } from './errors.ts';

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1: host registry
  `
  CREATE TABLE hosts(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    connection_mode TEXT NOT NULL CHECK(connection_mode IN ('direct','ssh_alias')),
    connection_profile_json TEXT NOT NULL,
    declared_os TEXT NOT NULL DEFAULT 'unknown' CHECK(declared_os IN ('macos','linux','windows','unknown')),
    observed_os TEXT, observed_os_detail TEXT,
    description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]',
    default_remote_directory TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, last_check_id TEXT, identity_generation INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE capabilities(
    id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    key TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', declared_description TEXT NOT NULL DEFAULT '',
    declaration_source TEXT NOT NULL CHECK(declaration_source IN ('user','agent','import')),
    last_observation_json TEXT, observed_at TEXT, probe_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(host_id, key)
  );
  CREATE TABLE resources(
    id TEXT PRIMARY KEY, parent_host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    resource_kind TEXT NOT NULL CHECK(resource_kind IN ('physical_device','simulator','browser','other')),
    label TEXT NOT NULL, stable_external_id TEXT, declared_metadata_json TEXT NOT NULL DEFAULT '{}',
    observed_state TEXT, observed_at TEXT
  );
  CREATE TABLE checks(
    id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    host_revision INTEGER NOT NULL, identity_generation INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('connectivity','os','capability')),
    started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT, error_code TEXT,
    diagnostics_json TEXT, duration_ms INTEGER, probe_version TEXT, effective_target_summary TEXT
  );
  CREATE INDEX checks_host ON checks(host_id, started_at);
  CREATE TABLE check_leases(
    host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
    check_id TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE mutation_requests(
    idempotency_key TEXT PRIMARY KEY, operation TEXT NOT NULL, normalized_input_hash TEXT NOT NULL,
    result_reference TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE audit_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, source TEXT NOT NULL,
    action TEXT NOT NULL, host_id TEXT, revision_before INTEGER, revision_after INTEGER, details_json TEXT
  );
  CREATE TABLE host_trust(
    id INTEGER PRIMARY KEY AUTOINCREMENT, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    target_host TEXT NOT NULL, target_port INTEGER NOT NULL, algorithm TEXT NOT NULL, fingerprint TEXT NOT NULL,
    approved_at TEXT NOT NULL, source TEXT NOT NULL, identity_generation INTEGER NOT NULL
  );
  CREATE TABLE settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  `,
  // 2: projects + locations (v1.1)
  `
  CREATE TABLE projects(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    source_location_id TEXT, repository_identity_json TEXT, repo_subdirectory TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE project_locations(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    host_id TEXT REFERENCES hosts(id) ON DELETE CASCADE,
    execution_environment TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
    path_input TEXT, canonical_path TEXT, path_flavor TEXT NOT NULL CHECK(path_flavor IN ('windows','posix')),
    mode TEXT NOT NULL CHECK(mode IN ('adopt_existing','create_if_missing')),
    role TEXT NOT NULL CHECK(role IN ('source','execution')),
    enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, location_generation INTEGER NOT NULL DEFAULT 1,
    git_root TEXT, project_subdirectory TEXT, identity_state TEXT NOT NULL DEFAULT 'unverified',
    last_inspection_id TEXT, consistency_policy_json TEXT NOT NULL DEFAULT '{}', last_verified_sync_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE inspections(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    location_id TEXT NOT NULL REFERENCES project_locations(id) ON DELETE CASCADE,
    location_revision INTEGER NOT NULL, location_generation INTEGER NOT NULL, host_identity_generation INTEGER,
    inspected_at TEXT NOT NULL, path_state TEXT NOT NULL, result_json TEXT NOT NULL, manifest_ref TEXT, snapshot_id TEXT
  );
  CREATE TABLE sync_verifications(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_location_id TEXT NOT NULL, destination_location_id TEXT NOT NULL,
    generations_json TEXT NOT NULL, expected_source_snapshot TEXT NOT NULL, transfer_mode TEXT,
    policy_version TEXT NOT NULL, evidence_json TEXT NOT NULL, started_at TEXT NOT NULL, verified_at TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('verified','failed','partial','needs_recheck')), operation_id TEXT
  );
  CREATE TABLE project_operation_leases(
    destination_location_id TEXT PRIMARY KEY REFERENCES project_locations(id) ON DELETE CASCADE,
    owner TEXT NOT NULL, operation_id TEXT NOT NULL, expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL
  );
  `,
  // 3: password auth (DPAPI-encrypted blob; plaintext never stored)
  `
  CREATE TABLE host_secrets(
    host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('password')), secret_blob TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  `,
  // 4: plain-copy destinations already verified by content get the identity they earned
  `
  UPDATE project_locations SET identity_state='content_verified'
  WHERE identity_state='unverified' AND last_verified_sync_id IS NOT NULL;
  `,
  // 5: independent working setups: an execution location may pair with its own source folder
  `
  ALTER TABLE project_locations ADD COLUMN source_location_id TEXT REFERENCES project_locations(id);
  `,
  // 6: macOS code signing over SSH. One secret per (host, kind); a host-level signing mode chosen by the user.
  `
  CREATE TABLE host_secrets_v6(
    host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('password', 'build_keychain')), secret_blob TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(host_id, kind)
  );
  INSERT INTO host_secrets_v6 SELECT host_id, kind, secret_blob, updated_at FROM host_secrets;
  DROP TABLE host_secrets;
  ALTER TABLE host_secrets_v6 RENAME TO host_secrets;
  ALTER TABLE hosts ADD COLUMN signing_mode TEXT NOT NULL DEFAULT 'off' CHECK(signing_mode IN ('off', 'login_keychain', 'build_keychain'));
  ALTER TABLE hosts ADD COLUMN signing_state_json TEXT;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(dataDir: string, file = 'registry.db', upTo = SCHEMA_VERSION): DB {
  const db = new DatabaseSync(join(dataDir, file));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new AppError('SCHEMA_TOO_NEW', `Database schema v${version} is newer than this app (v${SCHEMA_VERSION}). Update the app; refusing to downgrade.`);
  }
  for (let v = version; v < upTo; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version=${v + 1}`);
    });
  }
  return db;
}

/** Short IMMEDIATE transaction. Never await network inside. */
export function tx<T>(db: DB, fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE');
      break;
    } catch (e) {
      if (attempt >= 3 || !String(e).includes('busy')) {
        throw new AppError('DATABASE_BUSY', 'Database is busy; retry shortly.', { retryable: true });
      }
    }
  }
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => new Date().toISOString();
