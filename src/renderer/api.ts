type Envelope<T> = { ok: true; result: T } | { ok: false; error: ApiError };
export type ApiError = { code: string; message: string; next_action?: string; current_revision?: number; issues?: { path: string; message: string }[]; [k: string]: unknown };

declare global {
  interface Window {
    api: {
      call: (method: string, arg?: unknown) => Promise<Envelope<unknown>>;
      pickFolder: () => Promise<string | null>;
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
