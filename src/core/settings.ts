import { z } from 'zod';
import type { DB } from './db.ts';

export const Settings = z.object({
  ssh_path: z.string().default('ssh'),
  scp_path: z.string().default('scp'),
  sftp_path: z.string().default('sftp'),
  ssh_keygen_path: z.string().default('ssh-keygen'),
  git_path: z.string().default('git'),
  connect_timeout_s: z.number().int().min(1).max(60).default(5),
  check_timeout_s: z.number().int().min(5).max(120).default(15),
  probe_timeout_s: z.number().int().min(5).max(300).default(30),
  inspect_timeout_s: z.number().int().min(10).max(600).default(120),
  stale_after_seconds: z.number().int().min(10).max(86_400).default(60),
  checks_retained_per_host: z.number().int().min(10).max(1000).default(100),
  gui_auto_check: z.boolean().default(false),
});
export type Settings = z.infer<typeof Settings>;

export function getSettings(db: DB): Settings {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[];
  return Settings.parse(Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json)])));
}

export function setSettings(db: DB, patch: Partial<Settings>): Settings {
  const merged = Settings.parse({ ...getSettings(db), ...patch });
  const stmt = db.prepare('INSERT INTO settings(key, value_json) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json');
  for (const k of Object.keys(patch)) stmt.run(k, JSON.stringify(merged[k as keyof Settings]));
  return merged;
}
