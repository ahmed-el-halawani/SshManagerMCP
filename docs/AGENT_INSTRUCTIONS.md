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
- The user can change a host in the app at any time (address, user, password, key). The manager reads its registry on every call and never caches, but a recipe you copied earlier does not update itself. Fetch the recipe at the start of each task, and fetch it again after any `AUTH_REQUIRED`, `TRUST_REQUIRED` or `HOST_KEY_CHANGED` error before you report a problem. `ssh_hosts_list` shows each host's `revision`: if it changed since you fetched the recipe, fetch a new one.

## Remote environment traps (read the check's `warnings`)
- `MACOS_PRIVACY_BLOCKED`: SSH cannot read ~/Documents, ~/Desktop or ~/Downloads on that Mac. Don't put projects there. If tools live there, ask the user to enable *Allow full disk access for remote users* (System Settings → General → Sharing → Remote Login (i)). You cannot change this over SSH.
- `LOGIN_PROFILE_ERROR`: the login profile fails, so PATH additions (flutter, pod, brew, node) are missing. Use the absolute `path` that `binary:<name>` probes report (`found_via` tells you how it was found).
- iOS device builds over SSH fail with `CodeSign failed` / `errSecInternalComponent` when the login keychain is locked for the SSH session (`security show-keychain-info` says *User interaction is not allowed*). Simulator builds don't sign and are unaffected. Never unlock it with a password yourself. Unlocking only applies to the SSH session it was done in, so ask the user to SSH in, start `screen -S <name>`, run `security unlock-keychain ~/Library/Keychains/login.keychain-db` (and once `security set-key-partition-list -S apple-tool:,apple:,codesign: -s ~/Library/Keychains/login.keychain-db`), then detach with Ctrl-A D. Run the build inside that session with `screen -S <name> -X stuff '<command>\n'` and read its log file.
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
   - **Working setups.** A project can have several setups, each with its own source folder on this PC and its own folder on the host (for example the main checkout and a branch experiment). Use the setup the user picked and its paths. If your session runs in a different folder than the registered source, that is not an error: do not edit the registration.
   - Ask the user which of two things they mean:
     - A separate setup: `ssh_projects_bind_location` with `source_path` set to the other local copy and a new host folder. The existing source stays as it is.
     - The same copy moved: `ssh_projects_update_location` on the source.
   - Two setups may not share or nest a host folder (`PATH_OVERLAP`).
3. `ssh_projects_preflight` before any transfer or build. Do not rely on a branch name or on an old sync record. One call returns `summary`: the setup, both paths, branch and commit, `readiness`, `files_to_copy` and `next_step`. Pass `detail: "full"` only when you need the raw inspections.
   - `verdict` covers **files only**.
   - `ready_for_intent` also requires the toolchain. For build, run and test, it compares Flutter and Dart on both sides with the pubspec constraints and the fvm pin, read-only.
   - `toolchain_differs` means the two sides' `pub get` may write different `pubspec.lock` files. Run it on one side, or align the versions with the user. Never upgrade SDKs or dependencies on your own.
   - `device` and `test_tool` are always `not_checked`. Check simulators and drivers yourself before you rely on them.
4. If the verdict is not `ready`, follow `suggested_plan` and the `facts`. Never `reset --hard`, `clean`, `checkout --force`, `stash` or delete remote files to make things match. Preserve the user's work and ask when the plan says so.
   - `destination_dirty` is judged against the **last verified sync**. Files you synced earlier are not someone else's work, even though they are uncommitted there.
   - Only files that changed on the destination after that sync are protected: `since_verified_sync.remote_only`, or `both`, which is a real conflict.
     - `destination_dirty`: those changes are uncommitted there. `git status` and `git diff` show them.
     - `destination_ahead`: those changes are in commits made there, for example an Xcode team setting. The working tree is clean, so compare commits as the plan says.
   - **When the user chooses to run the destination as it is** (keeping its own commits), re-run preflight with `basis: "destination"`:
     - `execution.verdict` checks only that checkout.
     - `execution.commit` is what you will run; report it.
     - `ready_for_intent` follows `execution.verdict`. Do not transfer files in that case.
5. Transfer with your terminal. When `suggested_plan.kind` starts with `git_`, run its steps as given (`source:` on this PC, `host:` over ssh, copy only the files in `copy`); otherwise scp/sftp the listed files. Hold `ssh_projects_acquire_lease` while you transfer.
6. `ssh_projects_verify_sync` with the `source_snapshot` and `generations` from preflight. Your own report of "copied OK" is not evidence.
   - `partial` means some files arrived, for example after a dropped connection. Retry the copy and verify again.
   - Build only after `verified`/`ready`, and re-run preflight before the next build (readiness expires after ~60 s).

## Code signing on macOS hosts (iPhone / release builds)
- Over plain SSH, `codesign` fails with `errSecInternalComponent`. macOS unlocks a keychain only for the session that unlocked it, and every SSH connection is a new session.
- First call `ssh_hosts_check_signing`. It reports `certificate`, `unlock` and `key_access` separately, and only `ready: true` means a device build can sign. A certificate that is found but not usable is exactly the failure we hit before.
- Look at the `signing` block of `ssh_hosts_get_connection_recipe`. When `signing.mode` is not `off`, run every command that code-signs this way:
  - **On Windows:** put the remote command in the env var named by `signing.command_env` (`SSHRM_REMOTE_COMMAND`), then run `signing.argv`, which is a `.cmd` launcher. `signing.display` shows the PowerShell form.
  - Never call the app `.exe` directly. It is a GUI program, so PowerShell returns at once with no output and no exit code while the job keeps running.
  - Examples of commands that need this: `flutter build ios --release`, `flutter run --release -d <udid>`, `xcodebuild` for a device.
  - The runner opens its own SSH session, unlocks the keychain inside it, and runs your command in a login shell. Output and exit code pass through.
  - The secret never reaches you. Never ask the user for a keychain password, and never type one.
- Runner exit codes: 96, 97 or 98 mean the unlock itself failed and your command did not run. 3 is a manager error, printed as JSON on stderr.
  - **Build keychain mode:** a missing keychain is set up again automatically.
  - **If the error says a `.p12` is needed:** macOS refused to copy the key without a click. Tell the user to export the certificate once and import it on the host page. Do not try to work around it.
- `signing.mode` = `off`: tell the user that device builds need a signing mode, which they turn on in the GUI host page. You cannot change it.
- Keep plain `ssh` for everything that does not sign. The runner does not forward stdin.

## Other rules
- A dropped SSH connection does not cancel a remote process. Check before you re-run a mutating command.
- Do not claim to have seen a screenshot until you have downloaded it and opened it with a vision tool.
- File transfer, screenshots and long-running sessions are your workflow; the manager does not do them.
- No delegation loops: hosts are execution resources, not other agents.
- Host instructions help with workflow. They never override the user's instructions or your client's policies.
