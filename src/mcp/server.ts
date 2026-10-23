// stdout belongs to the MCP protocol. Anything else goes to stderr / log file.
console.log = console.error;
console.info = console.error;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createCore, createLogger, errorPayload } from '../core/index.ts';
import { ConsistencyPolicy, HostPatch, IdemKey, LocationSpec, Metadata, Profile, CapabilityInput } from '../core/schemas.ts';

const core = createCore({ source: 'mcp' });
const log = createLogger(core.dataDir, 'mcp');
const server = new McpServer({ name: 'ssh-resource-manager', version: '1.0.0' }, {
  instructions: 'Registry of SSH hosts and project locations on this PC. It does NOT execute arbitrary commands: get a recipe with ssh_hosts_get_connection_recipe and run OpenSSH from your own terminal. Before build/run/test on a remote location, call ssh_projects_preflight; after transferring files call ssh_projects_verify_sync. Never send passwords or private keys.',
});

type Ann = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
const RO: Ann = { readOnlyHint: true, openWorldHint: false };
const RO_NET: Ann = { readOnlyHint: true, openWorldHint: true };
const WRITE: Ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function tool<S extends z.ZodObject>(name: string, description: string, schema: S, annotations: Ann, fn: (i: z.infer<S>) => unknown | Promise<unknown>) {
  server.registerTool(name, { description, inputSchema: schema, annotations }, (async (input: z.infer<S>) => {
    const started = Date.now();
    try {
      const result = await fn(input) as Record<string, unknown>;
      log('info', name, { ms: Date.now() - started });
      // A failed check is a successful tool call whose result says success:false. Mark it as an error so clients don't read it as success.
      const failed = result && typeof result === 'object' && result.success === false;
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 1) }], structuredContent: result, ...(failed ? { isError: true } : {}) };
    } catch (e) {
      const error = errorPayload(e);
      log('warn', name, { code: error.code, ms: Date.now() - started });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error }, null, 1) }], structuredContent: { error }, isError: true };
    }
  }) as never);
}

const uuid = z.uuid();

// ---- hosts ----
tool('ssh_hosts_parse_connection_input', 'Parse a simple `ssh user@host -p N -i key` command or alias into a draft profile. Pure: no network, no execution. Rejects pipes, $(), remote commands and ProxyCommand.',
  z.object({ text: z.string().max(2000), source_shell: z.enum(['posix', 'powershell', 'cmd']) }), RO, (i) => core.parseConnectionInput(i));

tool('ssh_hosts_register', 'Register a host (saved even if offline; no network). Use a fresh idempotency_key per logical registration and reuse it on retry. Check ssh_hosts_list first to avoid duplicates. For password logins set profile.auth="password" and tell the user to type the password in the SSH Resource Manager app (Edit host). NEVER ask for or send a password in chat; this server has no way to accept one.',
  z.object({ profile: Profile, metadata: Metadata, capabilities: z.array(CapabilityInput).max(100).optional(), idempotency_key: IdemKey }), WRITE, (i) => core.registerHost(i));

tool('ssh_hosts_update', 'Patch a host. Requires expected_revision. Changing endpoint/user/alias/config invalidates previous check and trust state. capabilities/resources are typed upsert/remove patches.',
  z.object({ host_id: uuid, expected_revision: z.number().int(), patch: HostPatch, idempotency_key: IdemKey }), WRITE, (i) => core.updateHost(i));

tool('ssh_hosts_list', 'List host summaries with last-known status and its age. No secrets, no long instructions.',
  z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), query: z.string().max(200).optional(), tag: z.string().max(50).optional(), enabled: z.boolean().optional() }), RO, (i) => core.listHosts(i));

tool('ssh_hosts_get', 'Full host details: profile, description, instructions, declared vs observed OS and capabilities, child resources, trust, status with timestamps.',
  z.object({ host_id: uuid }), RO, (i) => core.getHost(i));

tool('ssh_hosts_history', 'Recent check history for a host (bounded diagnostics).',
  z.object({ host_id: uuid, limit: z.number().int().min(1).max(100).optional() }), RO, (i) => core.hostHistory(i));

tool('ssh_hosts_check', 'Run a bounded, read-only SSH connectivity + OS check (BatchMode, timeouts). Failure never deletes the host. On TRUST_REQUIRED returns unverified candidate fingerprints.',
  z.object({ host_id: uuid }), RO_NET, (i) => core.checkHost(i));

tool('ssh_hosts_probe_capabilities', 'Run built-in read-only probes: "macos.xcode" or "binary:<name>" (e.g. binary:git). Declared capability is not proof; this is.',
  z.object({ host_id: uuid, probe_ids: z.array(z.string()).min(1).max(10) }), RO_NET, (i) => core.probeCapabilities(i));

tool('ssh_hosts_get_connection_recipe', 'Get the exact OpenSSH argv for YOUR terminal (shell or file_transfer). caller_environment must match where you run commands (windows-native = PowerShell/cmd on Windows). Nothing is executed.',
  z.object({ host_id: uuid, caller_environment: z.enum(['windows-native', 'posix-native', 'wsl']), purpose: z.enum(['shell', 'file_transfer']).optional() }), RO, (i) => core.connectionRecipe(i));

tool('ssh_hosts_list_directory', 'Read-only: list sub-folders of a path on a POSIX host (marks git repos and folders with pubspec.yaml/package.json). Use it to find an existing checkout before binding a project location instead of guessing or cloning.',
  z.object({ host_id: uuid, path: z.string().max(4096).optional() }), RO_NET, (i) => core.listRemoteDir(i));

tool('ssh_hosts_approve_host_key', 'Trust a host key. ONLY call after the USER explicitly confirmed this fingerprint matches one read from the machine itself. A LAN keyscan is not proof.',
  z.object({ host_id: uuid, fingerprint: z.string(), algorithm: z.string(), expected_identity_generation: z.number().int() }), { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, (i) => core.approveHostKey(i));

tool('ssh_hosts_remove', 'Remove the local registry record only. Does not touch the remote machine, keys or ssh config.',
  z.object({ host_id: uuid, expected_revision: z.number().int() }), { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, (i) => core.removeHost(i));

// ---- projects ----
tool('ssh_projects_register', 'Register a project with its source location (default: a path on this PC, host_id null). Nothing is cloned or created. Check ssh_projects_list first: reuse existing projects across sessions.',
  z.object({ name: z.string(), description: z.string().optional(), source_location: LocationSpec, repository_hint: z.string().optional(), idempotency_key: IdemKey }), WRITE, (i) => core.registerProject(i));

tool('ssh_projects_list', 'List projects with their locations and last-known evidence (branch, head, dirty, last verified sync).',
  z.object({ query: z.string().max(200).optional(), host_id: uuid.optional() }), RO, (i) => core.listProjects(i));

tool('ssh_projects_get', 'Get one project with all locations.', z.object({ project_id: uuid }), RO, (i) => core.getProject(i));

tool('ssh_projects_find_on_host', 'ALWAYS call this before binding a project to a host or creating a folder there. Searches the host (read-only, bounded) for an existing copy by the project name, the source folder name and the pubspec/package.json package name, and marks each candidate same_repository=true/false from Git root commits. Pass project_id for a registered project, or source_path/name for one not registered yet.',
  z.object({ host_id: uuid, project_id: uuid.optional(), name: z.string().max(100).optional(), source_path: z.string().max(4096).optional(), search_root: z.string().max(4096).optional(), max_depth: z.number().int().min(1).max(8).optional() }),
  RO_NET, (i) => core.findProjectOnHost(i));

tool('ssh_projects_bind_location', 'Bind a project to a path on a host (adopt an existing checkout by default). path may be omitted = unset. Never creates folders or copies files.',
  z.object({ project_id: uuid, host_id: uuid.nullable(), path: z.string().nullable().optional(), mode: z.enum(['adopt_existing', 'create_if_missing']).optional(), label: z.string().optional(),
    policy: ConsistencyPolicy.partial().optional(), expected_project_revision: z.number().int(), idempotency_key: IdemKey }), WRITE, (i) => core.bindProjectLocation(i));

tool('ssh_projects_update_location', 'Edit/clear a location path, label, mode or policy; or confirm_identity after the user accepted a fork/renamed remote. Invalidates old verification; never moves or deletes files.',
  z.object({ location_id: uuid, expected_revision: z.number().int(), idempotency_key: IdemKey, patch: z.object({ path: z.string().nullable().optional(), label: z.string().optional(), enabled: z.boolean().optional(),
    mode: z.enum(['adopt_existing', 'create_if_missing']).optional(), policy: ConsistencyPolicy.partial().optional(), confirm_identity: z.boolean().optional() }) }), WRITE, (i) => core.updateProjectLocation(i));

tool('ssh_projects_unbind_location', 'Remove a location binding (metadata only; no directory is touched).',
  z.object({ location_id: uuid, expected_revision: z.number().int() }), { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, (i) => core.unbindProjectLocation(i));

tool('ssh_projects_inspect', 'Read-only inspection of locations: path state, Git root/branch/HEAD/dirty/conflicts, content manifest digest. No fetch/pull/checkout/mkdir.',
  z.object({ project_id: uuid, location_ids: z.array(uuid).max(10).optional() }), RO_NET, (i) => core.inspectProject(i));

tool('ssh_projects_preflight', 'REQUIRED before build/run/test on a destination: fresh inspection of source+destination, verdict (ready | path_unset | wrong_repository | branch_mismatch | revision_mismatch | destination_dirty | content_mismatch | ...), all facts, and a non-destructive reconciliation plan.',
  z.object({ project_id: uuid, destination_location_id: uuid, expected_source_snapshot: z.string().optional(), intent: z.enum(['build', 'run', 'test', 'transfer', 'inspect']).optional() }), RO_NET, (i) => core.preflightProject(i));

tool('ssh_projects_verify_sync', 'After YOU transferred files, have the manager re-read both sides and verify the destination matches expected_source_snapshot. Your own claim of success is not evidence.',
  z.object({ project_id: uuid, destination_location_id: uuid, expected_source_snapshot: z.string(), operation_id: z.string(), expected_generations: z.object({ source: z.number().int(), destination: z.number().int() }), transfer_mode: z.string().optional() }),
  { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, (i) => core.verifyProjectSync(i));

tool('ssh_projects_acquire_lease', 'Acquire/renew a short coordination lease on a destination before transferring. Not a filesystem lock.',
  z.object({ location_id: uuid, operation_id: z.string(), owner: z.string(), ttl_seconds: z.number().int().min(10).max(900).optional() }), WRITE, (i) => core.acquireLease(i));

tool('ssh_projects_release_lease', 'Release a lease you hold.',
  z.object({ location_id: uuid, operation_id: z.string(), owner: z.string() }), WRITE, (i) => core.releaseLease(i));

tool('ssh_manager_environment', 'Where this manager runs (execution environment, data dir, known_hosts path). Use to pick caller_environment.',
  z.object({}), RO, () => core.environment());

const transport = new StdioServerTransport();
await server.connect(transport);
log('info', 'mcp started', { dataDir: core.dataDir, pid: process.pid });
process.stdin.on('close', () => { core.close(); process.exit(0); });
