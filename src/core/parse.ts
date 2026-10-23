/**
 * parse_connection_input: pure, no network, no shell. Supports a documented subset of a simple
 * `ssh` invocation. Anything that could be executable (pipes, substitution, remote command,
 * ProxyCommand...) is rejected instead of guessed.
 */
import { AliasProfile, DirectProfile } from './schemas.ts';

export type ShellKind = 'posix' | 'powershell' | 'cmd';
export type ParseResult = {
  ok: boolean;
  draft: Record<string, unknown> | null;
  missing_fields: string[];
  warnings: string[];
  errors: string[];
};

class Reject extends Error {}

export function tokenize(text: string, shell: ShellKind): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  const push = () => { if (has) out.push(cur); cur = ''; has = false; };
  const forbidden = shell === 'cmd' ? /[;|&<>^%()\n\r]/ : /[;|&<>`\n\r(){}]/;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c) && c !== '\n' && c !== '\r') { push(); continue; }
    if (c === "'" && shell !== 'cmd') {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new Reject('unterminated single quote');
      let s = text.slice(i + 1, end);
      i = end;
      // PowerShell: '' inside single quotes is a literal quote
      while (shell === 'powershell' && text[i + 1] === "'") {
        const e2 = text.indexOf("'", i + 2);
        if (e2 < 0) throw new Reject('unterminated single quote');
        s += "'" + text.slice(i + 2, e2);
        i = e2;
      }
      cur += s; has = true; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      for (; j < text.length && text[j] !== '"'; j++) {
        const d = text[j];
        if (d === '$' || d === '`' || (shell === 'cmd' && (d === '%' || d === '^'))) throw new Reject('expansion characters inside double quotes are not supported');
        if (shell === 'posix' && d === '\\' && (text[j + 1] === '"' || text[j + 1] === '\\')) { s += text[++j]; continue; }
        s += d;
      }
      if (j >= text.length) throw new Reject('unterminated double quote');
      cur += s; has = true; i = j; continue;
    }
    if (c === '$') throw new Reject('variables and command substitution ($) are not allowed');
    if (forbidden.test(c)) throw new Reject(`shell operator '${c}' is not allowed in a connection command`);
    if (c === '\\' && shell === 'posix') {
      if (i + 1 >= text.length) throw new Reject('trailing backslash');
      cur += text[++i]; has = true; continue;
    }
    cur += c; has = true;
  }
  push();
  return out;
}

const SUPPORTED_O = new Set(['port', 'user', 'identityfile', 'identitiesonly', 'proxyjump']);

export function parseConnectionInput(text: string, sourceShell: ShellKind): ParseResult {
  const res: ParseResult = { ok: false, draft: null, missing_fields: [], warnings: [], errors: [] };
  let tokens: string[];
  try {
    tokens = tokenize(text.trim(), sourceShell);
  } catch (e) {
    res.errors.push((e as Error).message);
    return res;
  }
  if (tokens.length === 0) { res.errors.push('empty input'); return res; }
  if (/(^|[\\/])ssh(\.exe)?$/i.test(tokens[0])) tokens.shift();

  const opts: { port?: number; user?: string; identity?: string; identitiesOnly?: boolean; jump?: string[]; config?: string } = {};
  const positional: string[] = [];
  try {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t.startsWith('-') || t === '-') {
        if (positional.length > 0) throw new Reject(`unexpected argument after destination ('${t}'): remote commands are not part of a connection profile`);
        positional.push(t);
        continue;
      }
      if (t === '--') throw new Reject("'--' is not supported in imported text");
      const flag = t.slice(0, 2);
      const take = () => { const v = t.length > 2 ? t.slice(2) : tokens[++i]; if (v === undefined) throw new Reject(`${flag} needs a value`); return v; };
      switch (flag) {
        case '-p': { const v = take(); if (!/^\d+$/.test(v) || +v < 1 || +v > 65535) throw new Reject(`invalid port '${v}'`); opts.port = +v; break; }
        case '-l': opts.user = take(); break;
        case '-i': opts.identity = take(); break;
        case '-F': opts.config = take(); break;
        case '-J': opts.jump = take().split(','); break;
        case '-o': {
          const v = take();
          const m = /^([A-Za-z]+)\s*[= ]\s*(.+)$/.exec(v);
          const key = m?.[1].toLowerCase();
          if (!m || !key) throw new Reject(`malformed -o '${v}'`);
          if (key === 'proxycommand' || key === 'localcommand' || key === 'permitlocalcommand' || key === 'match' || key === 'knownhostscommand') {
            throw new Reject(`${m[1]} is not accepted from imported text; manage advanced config in your ssh_config yourself`);
          }
          if (!SUPPORTED_O.has(key)) throw new Reject(`unsupported option -o ${m[1]}`);
          if (key === 'port') opts.port = +m[2];
          if (key === 'user') opts.user = m[2];
          if (key === 'identityfile') opts.identity = m[2];
          if (key === 'identitiesonly') opts.identitiesOnly = /^yes$/i.test(m[2]);
          if (key === 'proxyjump') opts.jump = m[2].split(',');
          break;
        }
        default:
          throw new Reject(`unsupported ssh option '${t}'`);
      }
    }
  } catch (e) {
    res.errors.push((e as Error).message);
    return res;
  }
  if (positional.length !== 1) { res.errors.push('expected exactly one destination'); return res; }

  let dest = positional[0];
  let user = opts.user;
  const at = dest.lastIndexOf('@');
  if (at > 0) { user ??= dest.slice(0, at); dest = dest.slice(at + 1); }
  if (/^\[.+\]$/.test(dest)) dest = dest.slice(1, -1);
  else if (dest.includes(':') && (dest.match(/:/g)?.length ?? 0) === 1) { res.errors.push('host:port is not ssh syntax; use -p PORT'); return res; }

  const looksLikeHost = user !== undefined || opts.port !== undefined || opts.identity !== undefined || /[.:]/.test(dest) || dest === 'localhost';
  if (!looksLikeHost) {
    const draft = { mode: 'ssh_alias', alias: dest, ...(opts.config ? { config_path: opts.config } : {}) };
    const p = AliasProfile.safeParse(draft);
    if (!p.success) { res.errors.push(...p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)); return res; }
    res.warnings.push(`'${dest}' has no user, port or dots; treated as an ssh_config alias. If it is a plain hostname, switch mode to direct and add a username.`);
    res.draft = p.data; res.ok = true;
    return res;
  }
  const draft: Record<string, unknown> = {
    mode: 'direct', hostname: dest, port: opts.port ?? 22, ...(user !== undefined ? { username: user } : {}),
    ...(opts.identity ? { identity_file: opts.identity, identities_only: opts.identitiesOnly ?? true } : {}),
    ...(opts.jump ? { proxy_jump: opts.jump } : {}), ...(opts.config ? { config_path: opts.config } : {}),
  };
  if (user === undefined) res.missing_fields.push('username');
  const p = DirectProfile.safeParse({ username: 'placeholder', ...draft });
  if (!p.success) { res.errors.push(...p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)); return res; }
  res.draft = draft;
  res.ok = res.missing_fields.length === 0;
  return res;
}
