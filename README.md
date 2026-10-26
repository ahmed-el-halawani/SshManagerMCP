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

## Connect your AI client
Open **Setup**, copy the generated JSON into your client's MCP config, and restart the client. The app never edits client configs. The JSON looks like this:
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
**Switch to SSH key:** on a Mac/Linux password host, the host page has a *Switch to SSH key* button. It generates a key on this PC, installs it on the host using the stored password, tests a key-only login, and only then switches the host to key auth. Host-key trust and project bindings are kept, and so is the password (macOS signing may still need it).
| `unreachable` | DNS, connection refused, or timeout. A timeout does not prove the machine is off; it can also be a firewall or a wrong address. |
| `ENVIRONMENT_MISMATCH` | The agent runs in WSL, but the manager runs native Windows. Run the agent's shell in PowerShell. WSL is a separate deployment that is not supported in v1. |
| Alias hosts | These use **your** `~/.ssh/config` and `known_hosts`. Verify the key by connecting once yourself. |

See [docs/CONTRACTS.md](docs/CONTRACTS.md) for tools, defaults and support limits.
