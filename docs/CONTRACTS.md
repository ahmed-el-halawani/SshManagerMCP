# Contracts, defaults, limits

## Storage
SQLite (`node:sqlite`, built into Node/Electron, so there is no native module and no ABI split). WAL mode, `busy_timeout=5000`, foreign keys on, short `BEGIN IMMEDIATE` transactions. No transaction is held while waiting on the network. Migrations are versioned through `PRAGMA user_version` (see `src/core/db.ts`): v1 has hosts, capabilities, resources, checks, check leases, idempotency, audit and trust; v2 adds projects, locations, inspections, sync_verifications and leases.

## MCP tools
All tool inputs are runtime-validated with Zod (strict objects, so unknown fields such as `password` are rejected). Results come back as compact JSON text plus the same object as `structuredContent`; null and empty-string fields are left out (absent = null), because every byte is agent context. Id fields are plain strings in the published schemas (validated as UUIDs at runtime) so the tool list stays small. Operational failures return `isError: true` with `{error: {code, message, retryable, next_action, ...}}`.

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

Error codes: `VALIDATION_ERROR NOT_FOUND REVISION_CONFLICT IDEMPOTENCY_CONFLICT SSH_NOT_INSTALLED ENVIRONMENT_MISMATCH DNS_FAILED CONNECTION_REFUSED CONNECTION_TIMEOUT NETWORK_UNREACHABLE AUTH_REQUIRED TRUST_REQUIRED HOST_KEY_CHANGED PROBE_UNSUPPORTED REMOTE_COMMAND_FAILED OUTPUT_LIMIT CHECK_IN_PROGRESS LEASE_HELD PATH_OVERLAP DATABASE_BUSY SCHEMA_TOO_NEW INTERNAL_ERROR`.

## Preflight
- **Verdict priority:** `path_unset, path_missing, unsupported_layout, wrong_repository, conflicts_present, source_changed, destination_dirty, branch_mismatch, revision_mismatch, identity_unverified, content_mismatch, needs_recheck, ready`.
- **Identity:** Git root commits. A folder name or remote URL is never proof. A mismatch needs an explicit `confirm_identity`.
- **Snapshot:** `sha256(HEAD | manifest digest | policy)`. The manifest holds the relative path, the type (file/symlink), the sha256 of the bytes and, in a Git repo, the Git blob id.
  - When both sides are Git repos, files are compared by blob id. CRLF vs LF checkouts of one commit match, and byte-only differences are reported as `filter_only_differences`.
  - Clean files take their blob id from the index. Only dirty and untracked files are re-read with `hash-object`.
- **Working setups (migration 5):** an execution location may set its own `source_location_id`, which is a non-primary source folder on this PC; `null` means the project's primary source.
  - Preflight and verify always use the destination's own pair.
  - `bind_location` with `source_path` reuses a source that has the same path, or creates a new one.
  - Unbinding a setup's last destination also removes its own source record.
  - At bind or update time, an execution path equal to, inside, or containing another location's path on the same machine fails with `PATH_OVERLAP`.
- **Changes since the last verified sync:** the baseline is the pair of manifests the manager read at the last `verified` sync of this setup.
  - Each differing path is classed `local_only`, `remote_only` or `both`.
  - `destination_dirty` blocks only `remote_only` and `both`. With no baseline yet, it falls back to "uncommitted on the destination and different from the source".
- **Readiness:** `verdict` covers files only. `summary.readiness` = `{connection, files, toolchain, device, test_tool}`.
  - Anything not probed is `not_checked`.
  - `toolchain` (intents build/run/test) is one of `ok`, `differs`, `incompatible`, `missing`, `not_checked` or `not_applicable`.
    - It is computed from the shallowest `pubspec.yaml`: environment `sdk`/`flutter` constraints and the `.fvmrc` pin.
    - It reads the SDKs from `bin/cache/flutter.version.json`, or from `flutter --version --machine` when that file is missing. It never runs `pub get`.
  - `ready_for_intent` is false when the toolchain is `missing` or `incompatible`.
- **Output:** `detail: "summary"` (the default) leaves out the raw per-side inspections, location/host ids, inspection ids, timestamps other than `ready_until`, the toolchain block when it was not checked, and `paths` of non-blocking facts. `"full"` includes all of it.
- **Git plans:** when the source is a Git repo on a branch (and the destination is missing or also a Git repo), `path_missing` (create_if_missing), `branch_mismatch` and `revision_mismatch` return `git_clone` / `git_switch` / `git_fast_forward`: exact `source:` and `host:` commands (bundle the branch, copy it to `/tmp/sshrm-sync.bundle`, clone / `fetch b:b && switch` / `fetch && merge --ff-only`), and `copy` = only the source's uncommitted files. Files a previous verified sync copied there uncommitted (unchanged since) are restored first, or git would refuse to update over them. Git refuses non-fast-forward updates, so destination commits are never overwritten. Copied files that a Windows `autocrlf` checkout holds with CRLF (Git blob id differs from the raw bytes) get a `perl -pi -e 's/$//'` host step, so the host has the bytes Git stores.
- **One SSH session per remote inspection:** listing, sha256 of every listed file and `git hash-object` of dirty files run in one script (out-of-scope files are hashed and dropped locally). On a password host every login costs ~1.6 s of askpass/DPAPI, so this took preflight/verify from ~5.5 s to ~2.4 s on a real Mac; key auth removes most of the rest.
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

## Password authentication (migrations 3, 6)
- **Profile:** `auth: "key" | "password"` (default `key`).
- **Storage:** the password is set only through the GUI (`setHostPassword`; no MCP tool exists) and stored as a DPAPI (CurrentUser) blob in `host_secrets`.
- **ssh options for password hosts:** `BatchMode=no`, `PreferredAuthentications=password,keyboard-interactive`, `PubkeyAuthentication=no`, `NumberOfPasswordPrompts=1`, `StrictHostKeyChecking=yes`. The env sets `SSH_ASKPASS=<data-dir>\askpass.cmd`, `SSH_ASKPASS_REQUIRE=force` and `SSHRM_HOST_ID`. No TTY is involved, so nothing can hang on a prompt. The helper answers **once per ssh connection**: after a wrong password ssh falls back from `password` to `keyboard-interactive` and asks again, and Windows OpenSSH (which runs each askpass through a helper `ssh.exe` child when it has no console) then hangs until the timeout. A second prompt is refused, so a wrong password is a fast `AUTH_REQUIRED` and one failed login on the server, not a 15 s `CONNECTION_TIMEOUT`.
- **Recipes:** return the same `env` and never the password.
- **Lifecycle:** changing a profile identity field deletes the secret. `auth`, `identity_file` and `identities_only` are **not** identity fields: they say how to log in to the same account, so changing them keeps trust, secrets and bound locations.
- **Switch to SSH key (GUI only, `switchToKeyAuth`; no MCP tool):** direct macOS/Linux hosts with a stored password.
  - Generates `<data-dir>\keys\<host_id>_ed25519` (no passphrase, comment `sshrm:<host_id>`), restricted to the current Windows user with `icacls`. An existing key is reused.
  - Logs in with the password and sends the public key over stdin. The remote side creates `~/.ssh` (700) and `authorized_keys` (600) and appends the key only if it is not already there.
  - Then tests a key-only login (`BatchMode=yes`, `IdentitiesOnly=yes`). Only if that works does the profile switch to `auth: key` with that `identity_file`. On any failure nothing changes.
  - The password stays stored (login-keychain signing uses it). The server's password login is not disabled, and removing the host does not delete the key file or the `authorized_keys` line.
- **Host-key candidates:** captured with `ssh` itself into a throwaway known_hosts file with all auth disabled, not with `ssh-keyscan`. Windows' keyscan 9.5 cannot negotiate key exchange with OpenSSH 10 servers. This also works through ProxyJump.

## Code signing over SSH (migration 6)
- **Schema:** `host_secrets` is keyed `(host_id, kind)`, where kind is `password` or `build_keychain`. `hosts.signing_mode` is `off` (the default), `login_keychain` or `build_keychain`. `hosts.signing_state_json` holds the setup result or the last error.
- **Who decides:** only the user sets the mode, through the GUI (`setSigningMode`; there is no MCP tool). Turning a mode off, or switching away from the build keychain, deletes the build keychain secret.
- **Runner:** `<exe> dist/cli/run.js --data-dir=… --host=… -- "<cmd>"`, returned as `signing.argv` in the macOS shell recipe.
  - The remote side runs `/bin/sh -c <wrapper> sshrm <cmd>`. The wrapper reads the secret as the first stdin line and passes it to `security unlock-keychain` through the `printf` builtin, so it is never in argv, env or logs.
  - It then runs `exec "${SHELL:-/bin/sh}" -lc "$1"`.
  - Exit codes: 96 = build keychain missing (the runner sets it up again once and retries), 97 = no secret on stdin, 98 = unlock failed, 3 = manager error.
- **`login_keychain`:** unlocks `~/Library/Keychains/login.keychain-db` with the stored host password.
- **`build_keychain`:** `~/Library/Keychains/sshrm-signing.keychain-db`, with a random password stored with DPAPI.
  - It has no auto-lock, holds only code-signing identities, comes first in the user search list, and its partition list allows `apple-tool:`, `apple:` and `codesign:`.
  - Setup (`ssh_hosts_setup_build_keychain`, or automatically on first run) exports identities from the login keychain using the stored password. macOS refuses that for keys whose access control needs a click (`needs_p12`). The user then imports a `.p12` once in the GUI; the file is read in the main process and sent over SSH stdin.
  - The `.p12` password is passed as an argument to `security import` for a moment, inside a temp directory with mode 700.
- **Identity change:** changing the host's identity deletes all its secrets and the signing state.

## Known limits (v1)
- Password auth needs Windows (DPAPI via Windows PowerShell 5.1, about 300 ms per decrypt).
- Project inspection on **Windows remote hosts** returns `PROBE_UNSUPPORTED` (POSIX hosts only). Host checks and probes do support Windows hosts.
- Executable bits are not part of the manifest. Symlinks are hashed by target. Submodules and Git LFS are flagged as `unsupported_layout`.
- A remote filename containing a newline is handled through sha256sum escaping, but this path is not tested.
- WSL is not supported as a caller environment for a Windows-native manager (`ENVIRONMENT_MISMATCH`).
- Alias hosts: trust is user-managed, and `approve_host_key` refuses.
