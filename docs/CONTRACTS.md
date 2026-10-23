# Contracts, defaults, limits

## Storage
SQLite (`node:sqlite`, built into Node/Electron, so there is no native module and no ABI split). WAL mode, `busy_timeout=5000`, foreign keys on, short `BEGIN IMMEDIATE` transactions. No transaction is held while waiting on the network. Migrations are versioned through `PRAGMA user_version` (see `src/core/db.ts`): v1 has hosts, capabilities, resources, checks, check leases, idempotency, audit and trust; v2 adds projects, locations, inspections, sync_verifications and leases.

## MCP tools
All tool inputs are runtime-validated with Zod (strict objects, so unknown fields such as `password` are rejected). Results come back as `structuredContent` plus the same JSON as text. Operational failures return `isError: true` with `{error: {code, message, retryable, next_action, ...}}`.

| Tool | Notes |
|---|---|
| `ssh_hosts_parse_connection_input` | Pure. Supports `user@host`, `-p`, `-l`, `-i`, `-F`, `-J`, `-o Port/User/IdentityFile/IdentitiesOnly/ProxyJump`, `[ipv6]`, and posix/powershell/cmd quoting. Rejects `; | & < > $ \``, remote commands, `ProxyCommand`/`LocalCommand`, and unknown options. |
| `ssh_hosts_register` / `_update` / `_remove` | Writes take an `idempotency_key`; updates and removes take `expected_revision`. Changing a profile identity field raises `identity_generation`, which invalidates checks, trust and bound locations. |
| `ssh_hosts_list` / `_get` / `_history` | Status includes `checked_at`, `age_seconds` and `stale`. |
| `ssh_hosts_check` | `BatchMode=yes`, `StrictHostKeyChecking=yes`, connect timeout 5 s, 15 s per attempt, POSIX bootstrap then cmd fallback. Results apply only if `identity_generation` is unchanged. |
| `ssh_hosts_probe_capabilities` | Built-ins only: `macos.xcode`, `binary:<name>`. A missing probe tool means `unknown`, not `unavailable`. |
| `ssh_hosts_get_connection_recipe` | Returns an argv array plus a display string for the local shell. Instructions and the remote dir are never injected. |
| `ssh_hosts_approve_host_key` | Direct hosts only. Re-scans and requires the fingerprint and algorithm to match. Never replaces an existing key. |
| `ssh_projects_register` / `_bind_location` / `_update_location` / `_unbind_location` | Metadata only, never mkdir/clone/copy. Path edits raise `location_generation`. |
| `ssh_projects_inspect` | Read-only. Git plumbing with porcelain v2 `-z`. A `.git` file (worktrees) is supported. Manifests are stored locally; only the digest is returned. |
| `ssh_projects_preflight` | Verdict plus all facts plus a non-destructive plan. See verdict order below. |
| `ssh_projects_verify_sync` | Re-reads both sides. Returns `verified` only if the source still equals `expected_source_snapshot` and the destination matches it within scope. |
| `ssh_projects_acquire_lease` / `_release_lease` | Coordination only, not a filesystem lock. |

Error codes: `VALIDATION_ERROR NOT_FOUND REVISION_CONFLICT IDEMPOTENCY_CONFLICT SSH_NOT_INSTALLED ENVIRONMENT_MISMATCH DNS_FAILED CONNECTION_REFUSED CONNECTION_TIMEOUT NETWORK_UNREACHABLE AUTH_REQUIRED TRUST_REQUIRED HOST_KEY_CHANGED PROBE_UNSUPPORTED REMOTE_COMMAND_FAILED OUTPUT_LIMIT CHECK_IN_PROGRESS LEASE_HELD DATABASE_BUSY SCHEMA_TOO_NEW INTERNAL_ERROR`.

## Preflight
- **Verdict priority:** `path_unset, path_missing, unsupported_layout, wrong_repository, conflicts_present, source_changed, destination_dirty, branch_mismatch, revision_mismatch, identity_unverified, content_mismatch, needs_recheck, ready`.
- **Identity:** Git root commits. A folder name or remote URL is never proof. A mismatch needs an explicit `confirm_identity`.
- **Snapshot:** `sha256(HEAD | manifest digest | policy)`. The manifest holds relative path, type (file/symlink) and sha256 of the bytes. Bytes are compared exactly, so CRLF vs LF counts as a difference.
- **Scope:** `git ls-files --cached --others --exclude-standard` (tracked plus non-ignored untracked files). Credentials (`.env*`, `*.pem`, keys) are always excluded. Non-Git projects also exclude `node_modules`, `build`, `dist`, `Pods`, `.dart_tool`, `.gradle`, `DerivedData`, `__pycache__`, `.venv` and `.git`. Project-specific globs go in `policy.exclusions`.
- **Stale files:** a destination file that a previous verified sync copied but the source no longer has is reported as stale-owned. Unknown extra files block `ready` until the user decides.
- **Default policy:** `source_snapshot` mode, same branch required, detached HEAD blocked, readiness valid for 60 s.

## Defaults
| Setting | Default |
|---|---|
| Connect timeout | 5 s |
| Check timeout | 15 s |
| Probe timeout | 30 s |
| Inspection timeout | 120 s |
| Probe output | 64 KiB per stream |
| Inspection output | 64 MiB |
| Stale after | 60 s |
| Check history | 100 per host |
| GUI auto-check | off (opt-in: every 60 s, at most 2 at a time, with jitter) |
| Log rotation | at 5 MiB, one rotated file |

## Password authentication (migration 3)
- **Profile:** `auth: "key" | "password"` (default `key`).
- **Storage:** the password is set only through the GUI (`setHostPassword`; no MCP tool exists) and stored as a DPAPI (CurrentUser) blob in `host_secrets`.
- **ssh options for password hosts:** `BatchMode=no`, `PreferredAuthentications=password,keyboard-interactive`, `PubkeyAuthentication=no`, `NumberOfPasswordPrompts=1`, `StrictHostKeyChecking=yes`. The env sets `SSH_ASKPASS=<data-dir>\askpass.cmd`, `SSH_ASKPASS_REQUIRE=force` and `SSHRM_HOST_ID`. No TTY is involved, so nothing can hang on a prompt.
- **Recipes:** return the same `env` and never the password.
- **Lifecycle:** changing a profile identity field deletes the secret.
- **Host-key candidates:** captured with `ssh` itself into a throwaway known_hosts file with all auth disabled, not with `ssh-keyscan`. Windows' keyscan 9.5 cannot negotiate key exchange with OpenSSH 10 servers. This also works through ProxyJump.

## Known limits (v1)
- Password auth needs Windows (DPAPI via Windows PowerShell 5.1, about 300 ms per decrypt).
- Project inspection on **Windows remote hosts** returns `PROBE_UNSUPPORTED` (POSIX hosts only). Host checks and probes do support Windows hosts.
- Executable bits are not part of the manifest. Symlinks are hashed by target. Submodules and Git LFS are flagged as `unsupported_layout`.
- A remote filename containing a newline is handled through sha256sum escaping, but this path is not tested.
- WSL is not supported as a caller environment for a Windows-native manager (`ENVIRONMENT_MISMATCH`).
- Alias hosts: trust is user-managed, and `approve_host_key` refuses.
