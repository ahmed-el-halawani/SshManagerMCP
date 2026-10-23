import { z } from 'zod';

// eslint-disable-next-line no-control-regex
const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);
const token = (re: RegExp, what: string) =>
  z.string().min(1).max(255).refine(noControl, `${what} contains control characters`).refine((s) => re.test(s), `invalid ${what}`);

/** Hostname, IPv4 or bare IPv6. No leading '-', no shell/ssh metacharacters. Unicode allowed. */
export const Hostname = token(/^[^\s\-@/\\'"`$;&|<>()[\]][^\s@/\\'"`$;&|<>()[\]]*$/, 'hostname');
export const Username = token(/^[^\s\-@:'"`$;&|<>()][^\s@:'"`$;&|<>()]*$/, 'username');
/** Literal ssh_config Host alias: no wildcard/negation/list. */
export const Alias = token(/^[^\s\-*?!,'"`$;&|<>()][^\s*?!,'"`$;&|<>()]*$/, 'alias');
const LocalPath = z.string().min(1).max(1024).refine(noControl, 'path contains control characters');

export const DirectProfile = z.object({
  mode: z.literal('direct'),
  hostname: Hostname,
  port: z.number().int().min(1).max(65535).default(22),
  username: Username,
  /** 'password': the password itself is set in the GUI only and stored DPAPI-encrypted, never in the profile. */
  auth: z.enum(['key', 'password']).default('key'),
  identity_file: LocalPath.optional(),
  identities_only: z.boolean().default(false),
  proxy_jump: z.array(Alias).max(5).optional(),
  config_path: LocalPath.optional(),
  remote_shell_hint: z.enum(['posix', 'powershell', 'cmd']).optional(),
}).strict();

export const AliasProfile = z.object({
  mode: z.literal('ssh_alias'),
  alias: Alias,
  auth: z.enum(['key', 'password']).default('key'),
  config_path: LocalPath.optional(),
}).strict();

export const Profile = z.discriminatedUnion('mode', [DirectProfile, AliasProfile]);
export type Profile = z.infer<typeof Profile>;

export const OsEnum = z.enum(['macos', 'linux', 'windows', 'unknown']);

export const Metadata = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  declared_os: OsEnum.default('unknown'),
  description: z.string().max(10_000).default(''),
  instructions: z.string().max(20_000).default(''),
  tags: z.array(z.string().min(1).max(50)).max(50).default([]),
  default_remote_directory: z.string().max(1024).nullable().optional(),
}).strict();

export const CapabilityKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'capability key: lowercase letters, digits, . _ -');
export const CapabilityInput = z.object({
  key: CapabilityKey,
  label: z.string().max(200).default(''),
  declared_description: z.string().max(2000).default(''),
  enabled: z.boolean().default(true),
}).strict();

export const ResourceInput = z.object({
  id: z.uuid().optional(),
  resource_kind: z.enum(['physical_device', 'simulator', 'browser', 'other']),
  label: z.string().min(1).max(200),
  stable_external_id: z.string().max(200).nullable().optional(),
  declared_metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const Source = z.enum(['gui', 'mcp', 'internal']);
export type Source = z.infer<typeof Source>;

export const IdemKey = z.string().min(8).max(200);

export const RegisterHostInput = z.object({
  profile: Profile,
  metadata: Metadata,
  capabilities: z.array(CapabilityInput).max(100).default([]),
  idempotency_key: IdemKey,
}).strict();

export const HostPatch = z.object({
  profile: Profile.optional(),
  metadata: Metadata.partial().optional(),
  capabilities: z.object({
    upsert: z.array(CapabilityInput).max(100).default([]),
    remove: z.array(CapabilityKey).max(100).default([]),
  }).optional(),
  resources: z.object({
    upsert: z.array(ResourceInput).max(100).default([]),
    remove: z.array(z.uuid()).max(100).default([]),
  }).optional(),
}).strict();

export const UpdateHostInput = z.object({
  host_id: z.uuid(),
  expected_revision: z.number().int().min(1),
  patch: HostPatch,
  idempotency_key: IdemKey,
}).strict();

// ---- projects ----
export const ConsistencyPolicy = z.object({
  mode: z.enum(['source_snapshot', 'git_state']).default('source_snapshot'),
  require_same_branch: z.boolean().default(true),
  allow_detached: z.boolean().default(false),
  exclusions: z.array(z.string().min(1).max(200)).max(200).default([]),
  readiness_max_age_seconds: z.number().int().min(5).max(3600).default(60),
}).strict();
export type ConsistencyPolicy = z.infer<typeof ConsistencyPolicy>;

export const LocationSpec = z.object({
  host_id: z.uuid().nullable(),
  path: z.string().min(1).max(4096).refine(noControl).nullable().optional(),
  mode: z.enum(['adopt_existing', 'create_if_missing']).default('adopt_existing'),
  label: z.string().max(200).default(''),
  policy: ConsistencyPolicy.partial().optional(),
}).strict();
