# Acceptance report (v1.1), 2026-10-23

**Tested on:** Windows 11 Pro 26200, Node 24.18, Electron 44.3.0 (Node 24.20), OpenSSH_for_Windows 9.5p2, Git 2.50.1.
**Remote targets:** a fake `ssh` (`tests/fixtures/fake-ssh.mjs`) that either returns scripted OpenSSH failures or runs the *real* remote scripts through Git-for-Windows `sh`.
**No real Mac/Linux host and no real AI client (beyond the official MCP SDK client) were used.** Mock and local-`sh` results are not real-device verification.

Run everything with `npm test`. That covers 26 tests plus a smoke test of the MCP server under the Electron runtime.

| # | Result | Evidence |
|---|---|---|
| 1, 2 | ✅ automated | `hosts.test.ts` "GUI and MCP see…" (shared DB, restart). `mcp.test.ts` MCP register → GUI core sees it. GUI polls every 2 s. |
| 3 | ✅ | offline host: DNS/auth/trust/changed classified, metadata kept, nothing invented |
| 4, 5 | ✅ | idempotency replay and conflict; REVISION_CONFLICT keeps the first edit |
| 6 | ✅ | a slow check finishing after an endpoint change is stored as history only, state stays `unchecked` |
| 7 | ✅ partial | TRUST_REQUIRED / HOST_KEY_CHANGED never auto-accept. Approval re-scans and refuses to replace a key. The approval path is not exercised against a real sshd. |
| 8 | ✅ | BatchMode, strict checking, no secrets in DB, strict schema rejects `password` |
| 9, 10 | ✅ | `parse.test.ts`: suffix, `$()`, pipe, ProxyCommand rejected; spaces in paths, IPv6, ports, posix/powershell/cmd quoting |
| 11 | ✅ by design | capabilities are stored separately from connectivity. Real Xcode probe not run. |
| 12 | ✅ | a hung ssh is killed (taskkill /T) within the bound with no leftover process; output flood truncated → OUTPUT_LIMIT |
| 13 | ✅ | raw initialize writes only JSON-RPC to stdout; SDK client initialize/list/call works |
| 14 | ✅ | `caller_environment: wsl` → ENVIRONMENT_MISMATCH |
| 15 | ⚠ manual | alias hosts use the user's ssh_config and known_hosts untouched. Needs a real alias to verify. |
| 16 | ⚠ manual | needs a real host plus an agent terminal |
| 17 | ✅ | the core works with no Xcode/iPhone present |
| 18 | ✅ | GUI screenshot: `<script>`/`<b>` in description render as text. IPC is an allow-list of core methods, with no exec channel. Sandbox, contextIsolation and CSP are on. |
| 19 | ✅ partial | the packaged `win-unpacked\SSH Resource Manager.exe` runs the GUI and the MCP server (`ELECTRON_RUN_AS_NODE`) without global Node, sharing one DB. The NSIS installer was built but **not installed** on a clean machine. |
| 21, 23 | ✅ | binding an unset or missing path creates nothing |
| 22 | ✅ | a new core after close rediscovers the same location |
| 24 | ✅ | path edit: generation+1, inspection/sync cleared, old folder untouched |
| 25 | ✅ | same branch with a different commit → revision_mismatch; same commit with different WIP → destination_dirty |
| 26 | ✅ | other branch / detached → branch_mismatch, nothing switched |
| 27 | ✅ | destination WIP is protected (`preserve_work` plan) |
| 28 | ✅ | a matching clone is `ready` with no transfer; a stale one gets an incremental plan listing only the changed files |
| 29 | ✅ | an unrelated repo with the same folder name and same tree → wrong_repository (root-commit identity) |
| 30 | ✅ | a source edit after preflight → verify returns needs_recheck; an unperformed transfer is not verified |
| 31 | ✅ | nested location and `~` → unsupported_layout; home and root dirs are not scanned |
| 32 | ✅ | non-Git manifest mode; node_modules and .env excluded |
| 33 | ✅ | a source deletion after a verified sync is reported (stale-owned), not `ready` |
| 34 | ✅ partial | a failed or partial verify never sets last_verified_sync; leases expire. Interrupted-transfer timing not simulated. |
| 35 | ✅ | the remote dir `dst with space & 'quote'` is inspected with the path passed as quoted data |
| 36 | ✅ | every preflight re-inspects and reports the snapshot IDs it used |
| 20 | — | this document |
| PW | ✅ **real sshd** | `password.e2e.test.ts` with real Windows OpenSSH 9.5 against a real OpenSSH 10.3 sshd (Docker `linuxserver/openssh-server`, password-only). Covers: trust required first, no password → AUTH_REQUIRED, wrong password → AUTH_REQUIRED (bounded), correct password → reachable/linux, `binary:sh` probe, the agent recipe run as argv+env returns `hello-from-tester Linux`, a password with `& ' %` survives, no plaintext in DB/output/helper, and an endpoint change deletes the secret. |

## Still needs your machines
1. Install `SSH Resource Manager Setup 1.0.0.exe`, open **Setup**, and paste the MCP JSON into your AI client.
2. From chat: register your Mac, `ssh_hosts_check`, verify the fingerprint on the Mac, approve, probe `macos.xcode`, get a recipe, and run two read-only commands from the agent's terminal.
3. Bind an existing checkout on the Mac to a PC project, preflight, let the agent reconcile, verify, restart the client, and rediscover the binding.
