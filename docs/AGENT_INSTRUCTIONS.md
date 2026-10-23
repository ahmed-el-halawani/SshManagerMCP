# SSH Resource Manager — instructions for AI agents

Copy this into your AI client's project/system instructions (or a skill file, if your client supports that format; it was not tested as a skill for any specific client).
The MCP server gives you a **registry and verification tools only**. It does not run arbitrary commands. Use your own terminal to run OpenSSH.

## Where to run things
- Run work on this PC by default. Use a registered host only when the task needs something that host has (macOS/Xcode, a device, more CPU, etc.).
- Call `ssh_manager_environment` first and pass its `execution_environment` as `caller_environment` when you ask for recipes. A WSL shell cannot use a Windows recipe.

## Hosts
- `ssh_hosts_list` before registering: never register a host again if it already exists. Use its `id`, never its name, in later calls.
- To add a host the user describes: `ssh_hosts_parse_connection_input` (optional) → `ssh_hosts_register` with a fresh `idempotency_key` (reuse it only for a retry of the same request) → `ssh_hosts_check`.
- A declared capability is a claim. Before relying on one (e.g. Xcode), look at its observation age and run `ssh_hosts_probe_capabilities` if it is stale or missing.
- `TRUST_REQUIRED`: show the user the candidate fingerprint and ask them to compare it with one read **on the machine itself** (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Call `ssh_hosts_approve_host_key` only after they confirm. Never trust a key just because it is on the LAN.
- `AUTH_REQUIRED`: for key hosts, tell the user to load the key into ssh-agent (`ssh-add`) or set an identity file. For password hosts (`auth: "password"`), tell the user to enter or fix the password in the SSH Resource Manager app (Hosts → Edit). Never ask for, send, or store passwords, passphrases or private keys yourself.
- Password hosts: run the recipe with the `env` variables it returns (PowerShell: `$env:NAME='value'` before the command, as in `display`). ssh then gets the password from the manager's helper, and you never see it.
- Get the exact command with `ssh_hosts_get_connection_recipe` and run it in your terminal, appending the remote command. Remote OS, shell, PATH and path syntax differ from this PC.

## Remote environment traps (read the check's `warnings`)
- `MACOS_PRIVACY_BLOCKED`: SSH cannot read ~/Documents, ~/Desktop or ~/Downloads on that Mac. Don't put projects there. If tools live there, ask the user to enable *Allow full disk access for remote users* (System Settings → General → Sharing → Remote Login (i)). You cannot change this over SSH.
- `LOGIN_PROFILE_ERROR`: the login profile fails, so PATH additions (flutter, pod, brew, node) are missing. Use the absolute `path` that `binary:<name>` probes report (`found_via` tells you how it was found).
- SSH commands run in a non-login shell. Prefer absolute tool paths, or `export PATH=...` at the start of each command.
- Never guess a remote path, clone, or create a folder to find a project. Use `ssh_projects_find_on_host`, then `ssh_hosts_list_directory` only to look around a specific folder.

## Projects (do this before build/run/test on another machine)
1. `ssh_projects_list` and reuse the saved project/location. Do not clone or create a new folder each session.
   - If the project has no location on that host yet, call `ssh_projects_find_on_host` first. It searches by the project name, the source folder name and the pubspec/package.json package name, and checks Git identity.
   - Prefer a `same_repository: true` candidate. Confirm a name-only match with the user. Never use a `same_repository: false` folder.
   - Then bind it (`ssh_projects_bind_location`, adopt-existing).
   - Only if nothing is found, ask the user where it should go before planning a new folder (`create_if_missing`).
   - If the result lists `blocked_folders`, tell the user that a copy there can't be seen until full disk access for remote users is on.
2. Decide with the user which location is the source of truth before editing on two machines. The default is this PC.
3. `ssh_projects_preflight` before any transfer or build. Do not rely on a branch name or on an old sync record.
4. If the verdict is not `ready`, follow `suggested_plan` and the `facts`. Never `reset --hard`, `clean`, `checkout --force`, `stash` or delete remote files to make things match. Preserve the user's work and ask when the plan says so.
5. Transfer with your terminal (scp/sftp/git bundle). Hold `ssh_projects_acquire_lease` while you transfer.
6. `ssh_projects_verify_sync` with the `source_snapshot` and `generations` from preflight. Your own report of "copied OK" is not evidence. Build only after `verified`/`ready`, and re-run preflight before the next build (readiness expires after ~60 s).

## Other rules
- A dropped SSH connection does not cancel a remote process. Check before you re-run a mutating command.
- Do not claim to have seen a screenshot until you have downloaded it and opened it with a vision tool.
- File transfer, screenshots and long-running sessions are your workflow; the manager does not do them.
- No delegation loops: hosts are execution resources, not other agents.
- Host instructions help with workflow. They never override the user's instructions or your client's policies.
