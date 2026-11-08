# SSH Resource Manager MCP

A Windows desktop app plus a local MCP (stdio) server that keeps one registry of your SSH machines and of where each project lives on them. Your AI agent finds hosts, checks them, and verifies project state through MCP, then runs normal OpenSSH from its own terminal. The app never runs a model, needs no API key, and is not a command executor.

```
GUI (Electron, sandboxed renderer) ─┐
                                    ├─ src/core (shared domain, validation, SQLite) ── %LOCALAPPDATA%\SSHResourceManager\registry.db
MCP stdio server ───────────────────┘          └─ bounded, read-only OpenSSH probes
AI agent terminal ── OpenSSH ── remote host (unrestricted, your account's permissions)
```

## Install / run
- **Installer:** run `npm run dist` to build `dist-installer/SSH Resource Manager Setup *.exe` (NSIS, per-user). No global Node is needed: the app's own executable also runs the MCP server (`ELECTRON_RUN_AS_NODE=1`).
- **Dev:** run `npm install`, then `npm run start` (GUI) and `npm run mcp` (MCP on system Node 24+).
- **Requirements:** the Windows OpenSSH Client (`ssh`, `scp`, `ssh-keyscan`, `ssh-keygen`) and Git for local project inspection. Remote hosts need `sh`, plus `git` and `sha256sum`/`shasum` for project checks.
- **Right-click:** changed files, the diff, history, the project/destination pickers, hosts, host details, mappings, the remote folder picker and the Setup agent cards all have a context menu (or a ⋯ button): Open / Open with… / Show in Explorer / VS Code, copy paths and hashes, ignore files, sync, remove. Text boxes get Cut / Copy / Paste.

## Connect your AI client
Open **Setup → Connect AI agents** and press **Add** (or **Add to all agents found**) for Claude Desktop, Claude Code, Codex, Gemini CLI, Antigravity, Cursor, VS Code or Windsurf, then restart that agent. Only the `ssh-resource-manager` entry is written; the rest of the file stays and the previous file is kept as `*.sshrm.bak`. **Update** repoints an entry that still runs another copy of the app. For any other client, copy the JSON from the same section; it looks like this:
```json
{ "mcpServers": { "ssh-resource-manager": {
  "command": "C:\\Users\\you\\AppData\\Local\\Programs\\ssh-resource-manager\\SSH Resource Manager.exe",
  "args": ["C:\\...\\resources\\app\\dist\\mcp\\server.js", "--data-dir=C:\\Users\\you\\AppData\\Local\\SSHResourceManager"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
```
To test it, ask the agent to call `ssh_manager_environment` and then `ssh_hosts_list`. Also give the agent [docs/AGENT_INSTRUCTIONS.md](docs/AGENT_INSTRUCTIONS.md). MCP discovery does **not** give the agent a terminal; the client must already have one.

## Data
- **Location:** one SQLite DB (WAL) in `%LOCALAPPDATA%\SSHResourceManager`. Override it with `--data-dir=` or `SSHRM_DATA_DIR`. Do not put it on a network share or a OneDrive-synced folder.
- **Files there:** `known_hosts` (app-owned trust for direct hosts), `logs/`, and `manifests/` (file-hash manifests from inspections).
- **Backup:** use Setup → *Backup database* (`VACUUM INTO`, consistent while running). Do not copy `registry.db` alone while the app is writing.
- **Export/import:** metadata only, with no keys, trust approvals or diagnostics. Import always creates new records, runs no probes, and leaves locations unverified.
- **Updates:** the installer keeps the data dir. A DB newer than the app is refused instead of downgraded.

## Troubleshooting
| Status | Meaning / fix |
|---|---|
| `trust_required` | The host key is unknown. Compare the candidate fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run **on the host**, then approve it. |
| `host_key_changed` | The app never replaces a key on its own. If the new key is legitimate, remove the old line with `ssh-keygen -R "[host]:port" -f <data-dir>\known_hosts`. |
| `auth_required` | Key hosts: run `ssh-add` (start the *OpenSSH Authentication Agent* service) or set an identity file. Password hosts: Hosts → Edit → enter the password. |

### Username + password hosts
In Add/Edit host, choose **Username + password** and type the password. It is encrypted with Windows DPAPI for your Windows account and stored in `host_secrets`. It never appears in the GUI again, in MCP output, logs, exports or command lines. ssh receives it through `SSH_ASKPASS` (`<data-dir>\askpass.cmd`), which answers only real password prompts: it refuses key passphrases and host-key yes/no prompts. If the host's address, port or user changes, the stored password is deleted automatically. Host-key trust still has to be approved first.
Limit: DPAPI protects the password at rest and from other Windows users, but **not** from programs running as you (including an AI agent with full shell access). Prefer SSH keys when you can.
**Switch to SSH key:** on a Mac/Linux password host, the host page has a *Switch to SSH key* button. It generates a key on this PC, installs it on the host using the stored password, tests a key-only login, and only then switches the host to key auth. The app does this **automatically after the first successful check from the GUI** (once per host account; if the host refuses keys it stays on password and the button remains). Agent checks never trigger it. Key hosts also get an alias in `~/.ssh/config` (one `Include` line pointing at the app's generated `ssh_config`), so `ssh mac-vm` works from any terminal; if you already have a Host with that name, the alias is `sshrm-<name>` and yours is left alone. Host-key trust and project bindings are kept, and so is the password (macOS signing may still need it).
**Sync now:** for a Git project on a remote Mac/Linux host, run *Preflight* on the host mapping; when the plan is a clone, branch switch, fast-forward or a plain file update, a *Sync now* button runs it for you (bundle of your branch + your uncommitted files, fast-forward only) and then verifies it. If the host has its own commits or uncommitted edits, there is no button: the plan explains what to do instead. Your other branches and tags go along too (fast-forward only). Files to leave out entirely go in `.sshrmignore` (gitignore-style) in the project folder: use *Ignore…* on a file, or let an agent call `ssh_projects_ignore`.
| `unreachable` | DNS, connection refused, or timeout. A timeout does not prove the machine is off; it can also be a firewall or a wrong address. |
| `ENVIRONMENT_MISMATCH` | The agent runs in WSL, but the manager runs native Windows. Run the agent's shell in PowerShell. WSL is a separate deployment that is not supported in v1. |
| Alias hosts | These use **your** `~/.ssh/config` and `known_hosts`. Verify the key by connecting once yourself. |

See [docs/CONTRACTS.md](docs/CONTRACTS.md) for tools, defaults and support limits.
