import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Shared by GUI and MCP so both always open the same DB. Override: --data-dir=<p> or SSHRM_DATA_DIR. */
export function resolveDataDir(argv: string[] = process.argv): string {
  const flag = argv.find((a) => a.startsWith('--data-dir='));
  const dir = flag?.slice('--data-dir='.length) || process.env.SSHRM_DATA_DIR
    || (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'SSHResourceManager')
      : join(homedir(), '.local', 'share', 'ssh-resource-manager'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const executionEnvironment = (): 'windows-native' | 'posix-native' =>
  process.platform === 'win32' ? 'windows-native' : 'posix-native';
