import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { KNOWN_BIN_DIRS, sshRun, type Ctx } from './checks.ts';
import { getHostRow } from './hosts.ts';
import { classify, run } from './ssh.ts';

/**
 * Flutter/Dart toolchain readiness: what the project asks for (pubspec environment, fvm pin) vs the
 * SDKs on the source PC and on the destination. Read-only: never runs pub get or touches pubspec.lock.
 */
export type Requirements = { uses_flutter: boolean; dart?: string; flutter?: string; pinned_flutter?: string };
export type Sdk = { flutter: string | null; dart: string | null; path?: string };
export type ToolchainState = 'ok' | 'differs' | 'incompatible' | 'missing' | 'not_checked' | 'not_applicable';
type Fact = { kind: string; blocking: false; detail: string };

export function projectRequirements(dir: string): Requirements | null {
  let pub: string;
  try { pub = readFileSync(join(dir, 'pubspec.yaml'), 'utf8').replaceAll('\r\n', '\n'); } catch { return null; }
  const env = /^environment:[ \t]*\n((?:[ \t]+.*(?:\n|$))*)/m.exec(pub)?.[1] ?? '';
  const get = (k: string) => new RegExp(`^[ \\t]+${k}:[ \\t]*["']?([^"'\\n#]+?)["']?[ \\t]*(#.*)?$`, 'm').exec(env)?.[1]?.trim();
  const json = (f: string) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } };
  const pin = json('.fvmrc')?.flutter ?? json(join('.fvm', 'fvm_config.json'))?.flutterSdkVersion;
  return { uses_flutter: /^\s+sdk:\s*flutter\b/m.test(pub), dart: get('sdk'), flutter: get('flutter'), ...(typeof pin === 'string' ? { pinned_flutter: pin } : {}) };
}

const nums = (v: string) => v.split(/[-+ ]/)[0].split('.').map(Number);
export function compareVersions(a: string, b: string) {
  const x = nums(a), y = nums(b);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d); }
  return 0;
}

/** Pub-style constraint: any | ^x.y.z | 1.2.3 | >=a <b (space-separated comparators). Unknown syntax is not called incompatible. */
export function satisfies(v: string, c: string) {
  c = c.trim();
  if (!c || c === 'any') return true;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)/.exec(c);
  if (caret) {
    const [M, m] = [Number(caret[1]), Number(caret[2])];
    return compareVersions(v, c.slice(1)) >= 0 && compareVersions(v, M > 0 ? `${M + 1}.0.0` : `0.${m + 1}.0`) < 0;
  }
  const parts = [...c.matchAll(/(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2}\S*)/g)];
  return parts.every(([, op = '=', w]) => {
    const d = compareVersions(v, w);
    return op === '>=' ? d >= 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : op === '<' ? d < 0 : d === 0;
  });
}

export function evaluateToolchain(req: Requirements, source: Sdk | null, destination: Sdk | null): { state: ToolchainState; facts: Fact[] } {
  const facts: Fact[] = [];
  if (!destination?.flutter) {
    return { state: 'missing', facts: [{ kind: 'toolchain_missing', blocking: false, detail: 'Flutter was not found on the destination (PATH, login shell, common install folders), or its version could not be read.' }] };
  }
  let state: ToolchainState = 'ok';
  for (const [side, s] of [['destination', destination], ['source', source]] as const) {
    if (!s?.flutter) continue;
    const bad: string[] = [];
    if (req.flutter && !satisfies(s.flutter, req.flutter)) bad.push(`Flutter ${s.flutter} does not satisfy pubspec environment flutter: "${req.flutter}"`);
    if (req.dart && s.dart && !satisfies(s.dart, req.dart)) bad.push(`Dart ${s.dart} does not satisfy pubspec environment sdk: "${req.dart}"`);
    if (bad.length) {
      facts.push({ kind: 'toolchain_incompatible', blocking: false, detail: `${side}: ${bad.join('; ')}. Do not upgrade automatically; ask the user.` });
      if (side === 'destination') state = 'incompatible';
    }
    if (req.pinned_flutter && s.flutter !== req.pinned_flutter) {
      facts.push({ kind: 'toolchain_pin_mismatch', blocking: false, detail: `${side}: Flutter ${s.flutter} is not the version pinned by fvm (${req.pinned_flutter}); use "fvm flutter" there or ask the user.` });
      if (state === 'ok') state = 'differs';
    }
  }
  if (source?.flutter && source.flutter !== destination.flutter) {
    facts.push({ kind: 'toolchain_differs', blocking: false,
      detail: `Flutter ${source.flutter} (Dart ${source.dart ?? '?'}) on source vs ${destination.flutter} (Dart ${destination.dart ?? '?'}) on destination. Each side's "pub get" may resolve different packages and rewrite pubspec.lock; run it on one side only, or align versions.` });
    if (state === 'ok') state = 'differs';
  }
  return { state, facts };
}

const parseSdk = (text: string, path?: string): Sdk | null => {
  const f = /"frameworkVersion"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  const d = /"dartSdkVersion"\s*:\s*"([^"\s]+)/.exec(text)?.[1] ?? null;
  return f ? { flutter: f, dart: d, ...(path ? { path } : {}) } : null;
};

/** Flutter on this PC: reads the SDK's version cache file, falling back to `flutter --version --machine`. */
export async function localFlutter(): Promise<Sdk | null> {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const exe = ['flutter.bat', 'flutter'].map((e) => join(dir, e)).find((p) => existsSync(p));
    if (!exe) continue;
    try { const s = parseSdk(readFileSync(join(dir, 'cache', 'flutter.version.json'), 'utf8'), exe); if (s) return s; } catch { /* older SDKs: ask flutter */ }
    const r = await run(exe.endsWith('.bat') ? ['cmd.exe', '/d', '/c', exe] : [exe], ['--version', '--machine'], { timeoutMs: 90_000 });
    return parseSdk(r.stdout, exe);
  }
  return null;
}

const REMOTE_FLUTTER = `p=$(command -v flutter 2>/dev/null)
[ -z "$p" ] && p=$( (zsh -lc 'command -v flutter' 2>/dev/null || bash -lc 'command -v flutter' 2>/dev/null) | tail -n 1)
[ -z "$p" ] && for d in ${KNOWN_BIN_DIRS}; do [ -x "$d/flutter" ] && p="$d/flutter" && break; done
if [ -z "$p" ]; then echo "@@NONE"; else
  echo "@@PATH $p"; f="$(dirname "$p")/cache/flutter.version.json"
  if [ -f "$f" ]; then cat "$f"; else "$p" --version --machine 2>/dev/null; fi
fi
echo; echo "@@END"`;

export async function checkToolchain(ctx: Ctx, req: Requirements | null, destHostId: string | null) {
  if (!req) return { state: 'not_applicable' as ToolchainState, facts: [] as Fact[], note: 'no pubspec.yaml in the source; only Flutter/Dart toolchains are compared' };
  if (!req.uses_flutter) return { state: 'not_checked' as ToolchainState, facts: [] as Fact[], required: req, note: 'Dart-only package: SDK comparison is not implemented' };
  const source = await localFlutter();
  let destination: Sdk | null;
  if (destHostId) {
    const host = getHostRow(ctx.db, destHostId);
    if ((host.observed_os ?? host.declared_os) === 'windows') return { state: 'not_checked' as ToolchainState, facts: [] as Fact[], required: req, note: 'Windows destinations are not probed' };
    const r = await sshRun(ctx, host, REMOTE_FLUTTER, 120);
    if (!r.stdout.includes('@@END')) return { state: 'not_checked' as ToolchainState, facts: [] as Fact[], required: req, note: `could not probe the destination: ${classify(r).message}` };
    destination = r.stdout.includes('@@NONE') ? null : parseSdk(r.stdout, /^@@PATH (.+)$/m.exec(r.stdout)?.[1]?.trim());
  } else destination = source;
  return { ...evaluateToolchain(req, source, destination), required: req, source, destination };
}
