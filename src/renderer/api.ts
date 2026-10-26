type Envelope<T> = { ok: true; result: T } | { ok: false; error: ApiError };
export type ApiError = { code: string; message: string; next_action?: string; current_revision?: number; issues?: { path: string; message: string }[]; [k: string]: unknown };

declare global {
  interface Window {
    api: {
      call: (method: string, arg?: unknown) => Promise<Envelope<unknown>>;
      pickFolder: () => Promise<string | null>;
      loginItem: () => Promise<{ supported: boolean; enabled: boolean }>;
      setLoginItem: (enabled: boolean) => Promise<{ supported: boolean; enabled: boolean }>;
      importP12: (hostId: string, password: string) => Promise<Envelope<unknown> | null>;
      mcpConfig: () => Promise<unknown>;
      exportData: () => Promise<string | null>;
      importPreview: () => Promise<Envelope<unknown> | null>;
      importApply: () => Promise<Envelope<unknown>>;
      backup: () => Promise<string | null>;
      openDataDir: () => Promise<string>;
    };
  }
}

export class CallError extends Error {
  error: ApiError;
  constructor(error: ApiError) { super(error.message); this.error = error; }
}

export async function call<T = any>(method: string, arg?: unknown): Promise<T> {
  const r = await window.api.call(method, arg);
  if (!r.ok) throw new CallError(r.error);
  return r.result as T;
}

export const idem = () => `gui-${crypto.randomUUID()}`;

/**
 * Every GUI check goes through here. After the first successful check of a password host (the password works and the
 * host key is trusted), move it to an SSH key once: password logins cost ~1.6 s each (askpass + DPAPI), key logins
 * almost nothing. Tried once per host account, so a host that refuses keys is not retried on every check (the manual
 * "Switch to SSH key" button stays). Agent (MCP) checks never do this.
 */
export async function checkHost(hostId: string): Promise<any> {
  const r = await call('checkHost', { host_id: hostId });
  if (!r.success || !['macos', 'linux'].includes(r.observed_os)) return r;
  const h = await call('getHost', { host_id: hostId });
  const flag = `sshrm.keyAuthTried.${hostId}.${h.identity_generation}`;
  let tried = true;
  try { tried = !!localStorage.getItem(flag); localStorage.setItem(flag, '1'); } catch { /* no storage: never auto-switch */ }
  if (tried || h.auth !== 'password' || !h.password_stored || h.profile.mode !== 'direct') return r;
  try { return { ...r, key_auth: (await call('switchToKeyAuth', { host_id: hostId })).note }; }
  catch (e) { return { ...r, key_auth: `Stayed on password login: ${errText(e)}` }; }
}

export function errText(e: unknown): string {
  if (e instanceof CallError) {
    const x = e.error;
    return [x.code, x.message, x.issues?.map((i) => `${i.path}: ${i.message}`).join('; '), x.next_action].filter(Boolean).join(' — ');
  }
  return String((e as Error)?.message ?? e);
}

export function age(iso: string | null | undefined) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
