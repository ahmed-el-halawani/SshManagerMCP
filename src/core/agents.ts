// "Add to AI agent" in Setup: writes this app's MCP server entry into each agent's own config file (GUI only).
// Every write keeps the rest of the file, backs the old file up next to it (<file>.sshrm.bak), and is atomic (tmp + rename).
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SERVER = 'ssh-resource-manager';
export type McpEntry = { command: string; args: string[]; env: Record<string, string> };
type Format = 'json' | 'vscode' | 'toml';
export type Agent = { id: string; name: string; file: string; format: Format; detect: string; restart: string };
export type AgentStatus = { id: string; name: string; file: string; detected: boolean; state: 'missing' | 'current' | 'other_build' | 'unreadable'; restart: string; error?: string };

/** Where each agent reads user-level MCP servers on this PC. `detect`: the folder that exists once the agent is installed. */
export function agents(home: string, appData: string): Agent[] {
  const a = (id: string, name: string, file: string, format: Format, detect: string, restart: string) => ({ id, name, file, format, detect, restart });
  return [
    a('claude-desktop', 'Claude Desktop', join(appData, 'Claude', 'claude_desktop_config.json'), 'json', join(appData, 'Claude'), 'Quit Claude Desktop from its tray icon and open it again.'),
    a('claude-code', 'Claude Code', join(home, '.claude.json'), 'json', join(home, '.claude.json'), 'Start a new Claude Code session (or run /mcp).'),
    a('codex', 'Codex', join(home, '.codex', 'config.toml'), 'toml', join(home, '.codex'), 'Restart Codex.'),
    a('gemini', 'Gemini CLI', join(home, '.gemini', 'settings.json'), 'json', join(home, '.gemini'), 'Restart Gemini CLI.'),
    a('antigravity', 'Antigravity', join(home, '.gemini', 'antigravity', 'mcp_config.json'), 'json', join(home, '.gemini', 'antigravity'), 'Refresh MCP servers in Antigravity.'),
    a('cursor', 'Cursor', join(home, '.cursor', 'mcp.json'), 'json', join(home, '.cursor'), 'Restart Cursor.'),
    a('vscode', 'VS Code (Copilot)', join(appData, 'Code', 'User', 'mcp.json'), 'vscode', join(appData, 'Code', 'User'), 'Reload the VS Code window.'),
    a('windsurf', 'Windsurf', join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'json', join(home, '.codeium', 'windsurf'), 'Refresh MCP servers in Windsurf.'),
  ];
}

// ---- TOML (Codex): our table and its sub-tables are cut out and appended again; the rest of the file is untouched.
const tomlHeader = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const isOurs = (h: string) => h === `mcp_servers.${SERVER}` || h.startsWith(`mcp_servers.${SERVER}.`) || h === `mcp_servers."${SERVER}"` || h.startsWith(`mcp_servers."${SERVER}".`);
function tomlWithout(text: string) {
  let skip = false;
  return text.split(/\r?\n/).filter((line) => { const m = tomlHeader.exec(line); if (m) skip = isOurs(m[1]); return !skip; }).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
function tomlCommand(text: string): { command?: string; args?: string[] } | null {
  let in_ = false; const r: { command?: string; args?: string[] } = {}; let found = false;
  for (const line of text.split(/\r?\n/)) {
    const m = tomlHeader.exec(line);
    if (m) { in_ = m[1] === `mcp_servers.${SERVER}` || m[1] === `mcp_servers."${SERVER}"`; found ||= in_; continue; }
    if (!in_) continue;
    const kv = /^\s*(command|args)\s*=\s*(.+)$/.exec(line);
    try { if (kv) (r as Record<string, unknown>)[kv[1]] = JSON.parse(kv[2].replace(/'([^']*)'/g, (_s, x) => JSON.stringify(x))); } catch { /* unreadable value: treated as another build */ }
  }
  return found ? r : null;
}
const q = (s: string) => JSON.stringify(s); // a JSON string is a valid TOML basic string
const tomlBlock = (e: McpEntry) => [`[mcp_servers.${SERVER}]`, `command = ${q(e.command)}`, `args = [ ${e.args.map(q).join(', ')} ]`, '',
  `[mcp_servers.${SERVER}.env]`, ...Object.entries(e.env).map(([k, v]) => `${k} = ${q(v)}`)].join('\n');

// ---- JSON
const key = (f: Format) => (f === 'vscode' ? 'servers' : 'mcpServers');
function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* below */ }
  throw new Error(`${file} is not plain JSON (comments?), so it was left alone. Add the entry by hand with "Copy MCP config".`);
}

function current(a: Agent): { command?: unknown; args?: unknown } | null {
  if (a.format === 'toml') return existsSync(a.file) ? tomlCommand(readFileSync(a.file, 'utf8')) : null;
  const s = (readJson(a.file)[key(a.format)] as Record<string, { command?: unknown; args?: unknown }> | undefined)?.[SERVER];
  return s ?? null;
}

export function agentStatus(a: Agent, e: McpEntry): AgentStatus {
  const base = { id: a.id, name: a.name, file: a.file, detected: existsSync(a.detect), restart: a.restart };
  try {
    const c = current(a);
    if (!c) return { ...base, state: 'missing' };
    return { ...base, state: c.command === e.command && JSON.stringify(c.args) === JSON.stringify(e.args) ? 'current' : 'other_build' };
  } catch (err) { return { ...base, state: 'unreadable', error: (err as Error).message }; }
}

function write(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.sshrm.bak`);
  const tmp = `${file}.sshrm.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Adds (or repoints) our entry; `entry` null removes it. Other servers and settings stay as they were. */
export function setAgentEntry(a: Agent, e: McpEntry | null) {
  if (a.format === 'toml') {
    const rest = existsSync(a.file) ? tomlWithout(readFileSync(a.file, 'utf8')) : '';
    return write(a.file, [rest, e && tomlBlock(e)].filter(Boolean).join('\n\n') + '\n');
  }
  const doc = readJson(a.file);
  const servers = { ...(doc[key(a.format)] as Record<string, unknown> | undefined) };
  if (e) servers[SERVER] = a.format === 'vscode' ? { type: 'stdio', ...e } : { ...(a.id === 'claude-code' ? { type: 'stdio' } : {}), ...e };
  else delete servers[SERVER];
  doc[key(a.format)] = servers;
  write(a.file, JSON.stringify(doc, null, 2) + '\n');
}
