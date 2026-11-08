import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { age, call, CallError, checkHost, copy, errText, idem, type AgentStatus } from './api.ts';
import { copyItem, hostPath, localFileItems, localPath, useMenu, type MenuItem } from './menu.tsx';

type Status = { state: string; checked_at: string | null; stale: boolean; error_code: string | null };
type HostSummary = { id: string; name: string; enabled: boolean; target: string; active_address?: string; declared_os: string; observed_os: string | null; os_mismatch: boolean; tags: string[]; revision: number; status: Status; capability_keys: string[] };

function usePoll<T>(fn: () => Promise<T>, deps: unknown[], ms = 2000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tick = useCallback(async () => {
    try { setData(await fn()); setError(null); } catch (e) { setError(errText(e)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { tick(); const t = setInterval(tick, ms); return () => clearInterval(t); }, [tick, ms]);
  return { data, error, reload: tick };
}

const StatusDot = ({ s }: { s: Status }) => {
  const cls = s.state === 'reachable' ? 'dot-ok' : ['unreachable', 'error', 'host_key_changed'].includes(s.state) ? 'dot-bad' : s.state === 'unknown' ? 'dot-muted' : 'dot-warn';
  return <span className={`badge-dot ${cls}`} title={s.state.replace('_', ' ')} />;
};

const Badge = ({ s }: { s: Status }) => (
  <span className={`badge st-${s.state}`} title={s.error_code ?? ''}>
    <StatusDot s={s} />
    {s.state.replace('_', ' ')}{s.checked_at ? ` · ${age(s.checked_at)}` : ''}{s.stale && s.checked_at ? ' · stale' : ''}
  </span>
);

const Err = ({ e }: { e: string | null }) => (e ? <div className="error">{e}</div> : null);

// ═══════════════════════════════════════════════════════════
// Root App
// ═══════════════════════════════════════════════════════════

export function App() {
  const [tab, setTab] = useState<'projects' | 'hosts' | 'setup'>(() => (store.get('view') as 'projects' | 'hosts' | 'setup' | null) ?? 'projects');
  const [hostId, setHostId] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const { data: hostsData } = usePoll(() => call<{ hosts: HostSummary[] }>('listHosts', { limit: 100 }), [], 3000);

  const hostCount = hostsData?.hosts.length ?? 0;
  const onlineCount = hostsData?.hosts.filter(h => h.status.state === 'reachable').length ?? 0;
  const go = (t: typeof tab) => { setTab(t); store.set('view', t); setHostId(null); setEditing(null); };
  useEffect(() => { const f = () => go('projects'); window.addEventListener('sshrm-open-projects', f); return () => window.removeEventListener('sshrm-open-projects', f); }, []);

  return (
    <div className="app">
      {/* ── Menu bar (GitHub Desktop's File/Edit/View row) ───── */}
      <nav className="gd-menubar">
        <span className="gd-logo">⌘</span>
        {(['projects', 'hosts', 'setup'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => go(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
        <span className="grow-1" />
        <span className="gd-menubar-status"><span className={`badge-dot ${onlineCount ? 'dot-ok' : 'dot-muted'}`} /> {onlineCount}/{hostCount} hosts online</span>
      </nav>

      {tab === 'projects' ? <ProjectsView hosts={hostsData?.hosts ?? []} onOpenHost={(id) => { setTab('hosts'); setHostId(id); }} /> : (
        <div className="content-area">
          {tab === 'hosts' && editing && <HostForm hostId={editing === 'new' ? null : editing} onDone={(id) => { setEditing(null); if (id) setHostId(id); }} />}
          {tab === 'hosts' && !editing && hostId && <HostDetail id={hostId} onBack={() => setHostId(null)} onEdit={() => setEditing(hostId)} />}
          {tab === 'hosts' && !editing && !hostId && <HostList onOpen={setHostId} onAdd={() => setEditing('new')} onEdit={(id) => setEditing(id)} />}
          {tab === 'setup' && <Setup />}
        </div>
      )}
    </div>
  );
}

/** Per-viewer UI memory (last view/project/destination). Storage can be blocked: never required. */
const store = {
  get: (k: string) => { try { return localStorage.getItem(`sshrm.${k}`); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`sshrm.${k}`, v); } catch { /* not persisted */ } },
};

// ═══════════════════════════════════════════════════════════
// Projects workspace (laid out like GitHub Desktop)
//   Current repository → project · Current worktree → destination (host + folder)
//   Current branch → source branch · Fetch origin → Check host (preflight)
//   Changes / History → what Sync would send / past verified syncs · Commit to main → Sync to <host>
// ═══════════════════════════════════════════════════════════

function ToolbarItem({ icon, label, value, sub, open, onClick, disabled, onContextMenu }: { icon: string; label: string; value: ReactNode; sub?: ReactNode; open?: boolean; onClick?: () => void; disabled?: boolean; onContextMenu?: (e: React.MouseEvent) => void }) {
  return (
    <button className={`gd-tb ${open ? 'open' : ''} ${onClick ? '' : 'static'}`} onClick={onClick} onContextMenu={onContextMenu} disabled={disabled} tabIndex={onClick ? 0 : -1}>
      <span className="gd-tb-icon">{icon}</span>
      <span className="gd-tb-text">{label && <span className="gd-tb-label">{label}</span>}<span className="gd-tb-value">{value}</span>{sub && <span className="gd-tb-label">{sub}</span>}</span>
      {open !== undefined && <span className="gd-tb-caret">{open ? '▴' : '▾'}</span>}
    </button>
  );
}

const OUTCOME: Record<string, { icon: string; cls: string; text: string }> = {
  verified: { icon: '✓', cls: 'ok', text: 'Verified' }, failed: { icon: '✕', cls: 'bad', text: 'Failed' },
  partial: { icon: '◐', cls: 'warn', text: 'Partial' }, needs_recheck: { icon: '↻', cls: 'warn', text: 'Needs recheck' },
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ENV = navigator.userAgent.includes('Windows') ? 'windows-native' : 'posix-native';

/** A folder or file on a host: VS Code Remote when the host has an ssh alias (key hosts), else copy an ssh command. */
async function openOnHost(hostId: string, path: string | null | undefined): Promise<string> {
  const h = await call('getHost', { host_id: hostId });
  if (h.ssh_alias && path) { await window.api.openInVscode(path, h.ssh_alias); return `Opened ${path} in VS Code (Remote)`; }
  await copy((await call('connectionRecipe', { host_id: hostId, caller_environment: ENV })).display);
  return h.ssh_alias ? 'SSH command copied' : 'SSH command copied (VS Code Remote needs an SSH key login: Switch to SSH key on the host page)';
}

/** Removes one destination mapping (metadata only); the project goes too when it was its last host. */
async function removeMapping(project: any, dest: any, hostName: string): Promise<boolean> {
  const onlyHost = project.locations.filter((l: any) => l.role !== 'source').length === 1;
  if (!confirm(`Remove the mapping of "${project.name}" to ${hostName}?\n\nMetadata only: no folder on either machine is touched.${onlyHost ? '\nThe project itself is removed too (it has no other hosts).' : ''}`)) return false;
  await call('unbindProjectLocation', { location_id: dest.id, expected_revision: dest.revision });
  if (onlyHost) { const p = await call('getProject', { project_id: project.id }); await call('removeProject', { project_id: project.id, expected_revision: p.revision }); }
  return true;
}

/** Jump to the Projects view with this project and destination selected. */
function openInProjects(projectId: string, destId: string) {
  store.set('project', projectId); store.set('dest', destId); store.set('view', 'projects');
  window.dispatchEvent(new Event('sshrm-open-projects'));
}
const sourceDir = (p: any) => { const l = p?.locations.find((x: any) => x.id === p.source_location_id); return l?.canonical_path ?? l?.path_input ?? null; };

function ProjectsView({ hosts, onOpenHost }: { hosts: HostSummary[]; onOpenHost: (id: string) => void }) {
  const { data, reload } = usePoll(() => call('listProjects', {}), [], 3000);
  const projects: any[] = data?.projects ?? [];
  const [pid, setPid] = useState(() => store.get('project'));
  const [did, setDid] = useState(() => store.get('dest'));
  const [menu, setMenu] = useState<'project' | 'dest' | null>(null);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [pre, setPre] = useState<any>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'sync' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null); // host id for the New mapping dialog ('' = pick one)
  const [selSync, setSelSync] = useState<string | null>(null);
  const [selFile, setSelFile] = useState<string | null>(null);
  const [show, setShow] = useState<'all' | 'dirty' | 'clean' | 'kept'>('all');
  const [sideW, setSideW] = useState(() => Number(store.get('sideW')) || 260);
  const seq = useRef(0);
  // Drag the sidebar's right edge (double-click resets). The project toolbar item follows the same width, like GitHub Desktop.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX; const w0 = sideW; let w = w0;
    const move = (ev: MouseEvent) => { w = Math.min(720, Math.max(200, w0 + ev.clientX - x0)); setSideW(w); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('resizing'); store.set('sideW', String(w)); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); document.body.classList.add('resizing');
  };

  const project = projects.find((p) => p.id === pid) ?? projects[0];
  const dests: any[] = project?.locations.filter((l: any) => l.role !== 'source') ?? [];
  const dest = dests.find((l) => l.id === did) ?? dests[0];
  const source = project?.locations.find((l: any) => l.id === (dest?.source_location_id ?? project.source_location_id));
  const host = hosts.find((h) => h.id === dest?.host_id);
  const hist = usePoll(() => (dest ? call('syncHistory', { destination_location_id: dest.id, limit: 50 }) : Promise.resolve({ syncs: [] })), [dest?.id], 10_000);
  const syncs: any[] = hist.data?.syncs ?? [];
  const exec = pre?.suggested_plan.exec;
  const hostName = host?.name ?? 'host';
  const [menuNode, openMenu] = useMenu();
  const alias: string | undefined = usePoll(() => (dest?.host_id ? call('getHost', { host_id: dest.host_id }) : Promise.resolve(null)), [dest?.host_id], 60_000).data?.ssh_alias;
  const say = (p: Promise<unknown>) => p.then((m) => { if (typeof m === 'string') setNote(m); }, (e) => setErr(errText(e)));
  const ignore = async (pattern: string) => {
    try { await call('editProjectIgnore', { project_id: project.id, add: [pattern] }); setSelFile(null); setNote(`Added “${pattern}” to .sshrmignore`); check(); } catch (e) { setErr(errText(e)); }
  };

  const check = async () => {
    if (!project || !dest) return;
    const n = ++seq.current;
    setBusy('check'); setErr(null);
    try {
      const r = await call('preflightProject', { project_id: project.id, destination_location_id: dest.id, intent: 'transfer', detail: 'full' });
      if (n === seq.current) { setPre(r); setCheckedAt(new Date().toISOString()); }
    } catch (e) { if (n === seq.current) { setPre(null); setErr(errText(e)); } } finally { if (n === seq.current) setBusy(null); }
  };
  // Like GitHub Desktop fetching on open: picking a destination checks it (read-only over SSH).
  useEffect(() => { setPre(null); setNote(null); setErr(null); setSelSync(null); setSelFile(null); setCheckedAt(null); if (dest?.path_input) check(); }, [project?.id, dest?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Like GitHub Desktop: coming back to the window (after editing files here or on the host) re-checks, and so does a
  // 2-minute tick while it is visible. Skipped while a check/sync runs or the last check is under 15 s old.
  const latest = useRef({ check, busy, checkedAt, ok: !!dest?.path_input });
  latest.current = { check, busy, checkedAt, ok: !!dest?.path_input };
  useEffect(() => {
    const auto = () => {
      const l = latest.current;
      if (document.visibilityState === 'visible' && l.ok && !l.busy && (!l.checkedAt || Date.now() - Date.parse(l.checkedAt) > 15_000)) l.check();
    };
    window.addEventListener('focus', auto); document.addEventListener('visibilitychange', auto);
    const t = setInterval(auto, 120_000);
    return () => { window.removeEventListener('focus', auto); document.removeEventListener('visibilitychange', auto); clearInterval(t); };
  }, []);

  const sync = async (backup = false) => {
    if (backup && !confirm(`${plural(dirtyCount, 'file')} on ${hostName} has edits this PC doesn't have.

They will be saved in a git stash on ${hostName} (restore with "git stash pop" there), then this PC's version is synced.

Continue?`)) return;
    setBusy('sync'); setErr(null); setNote(null);
    try {
      const r = await call('syncProject', { project_id: project.id, destination_location_id: dest.id, backup_host_changes: backup });
      setNote(`${OUTCOME[r.outcome]?.text ?? r.outcome}: ${r.note}`);
      hist.reload(); reload();
      await check();
    } catch (e) { setErr(errText(e)); setBusy(null); }
  };

  const pickProject = (id: string) => { setPid(id); store.set('project', id); setMenu(null); setFilter(''); };
  const pickDest = (id: string) => { setDid(id); store.set('dest', id); setMenu(null); };

  // Changes list: every file that differs between this PC and the host. "Dirty" = the host's own work is on it
  // (uncommitted there, or in a commit made there): Sync never overwrites those.
  const allRows: FileRow[] = (pre?.files ?? []).map((f: any) => ({
    p: f.path, m: f.status === 'kept' ? 'K' : f.status === 'modified' ? 'M' : f.status === 'added' ? 'A' : 'D', dirty: f.host_dirty || f.host_committed,
    t: f.status === 'kept' ? `edited on ${hostName}, kept as is: this PC hasn't changed this file, so Sync leaves ${hostName}'s version alone` : [f.status === 'modified' ? `differs from ${hostName}` : f.status === 'added' ? `not on ${hostName} yet` : `only on ${hostName}`,
      f.host_dirty && `changed on ${hostName} and not committed there`, f.host_committed && `changed in a commit made on ${hostName}`,
      f.conflict && 'also changed on this PC (conflict)'].filter(Boolean).join(' · '),
  }));
  const dirtyCount = allRows.filter((r) => r.dirty).length;
  // Kept = files the sync never touches (host edits this PC didn't change, leftovers only on the host): hidden unless asked for.
  const keptCount = allRows.filter((r) => r.m === 'K').length;
  const rows = show === 'kept' ? allRows.filter((r) => r.m === 'K') : show === 'dirty' ? allRows.filter((r) => r.dirty) : allRows.filter((r) => r.m !== 'K' && (show === 'all' || !r.dirty));
  const selRow = allRows.find((r) => r.p === selFile);
  const kind = pre?.suggested_plan.kind as string | undefined;
  const commitStep: string | undefined = exec && kind ? ({ git_clone: 'Clone', git_switch: 'Switch to', git_fast_forward: 'Fast-forward' } as Record<string, string>)[kind] : undefined;
  const commitLine = commitStep && `${commitStep} ${exec.branch ?? ''}`.trim();
  const changeCount = allRows.length + (commitLine ? 1 : 0);
  const branch = pre?.summary.source.branch ?? source?.last_inspection?.branch ?? '—';
  const destPath = pre?.summary.destination.path ?? dest?.canonical_path ?? dest?.path_input;
  const srcPath = source?.canonical_path ?? source?.path_input;
  const selected = syncs.find((s) => s.id === selSync);
  // ── right-click menus ──
  const fileMenu = (r: FileRow): MenuItem[] => {
    const lp = localPath(srcPath, r.p), hp = hostPath(destPath, r.p);
    const dir = r.p.slice(0, r.p.lastIndexOf('/') + 1), ext = /[^/.]\.([^./]+)$/.exec(r.p)?.[1]; // "a/b.mp3" → mp3; dotfiles like ".firebaserc" have none
    return [
      { label: 'Open diff', icon: '⇆', onClick: () => setSelFile(r.p) },
      '-',
      ...(r.m === 'D' ? [{ label: 'Not on this PC', icon: '📄', disabled: true, onClick: () => {} }] : localFileItems(lp)),
      r.m !== 'A' && { label: `Open ${hostName}'s copy in VS Code`, icon: '🖥', title: alias ? '' : 'Needs an SSH key login on this host: copies an SSH command instead', onClick: () => say(openOnHost(dest.host_id, hp)) },
      '-',
      r.m !== 'D' && copyItem('Copy path', lp), copyItem('Copy relative path', r.p), r.m !== 'A' && copyItem(`Copy path on ${hostName}`, hp),
      '-',
      { label: 'Ignore this file', icon: '🚫', onClick: () => ignore(r.p) },
      dir && { label: <>Ignore folder <span className="mono">{dir}</span></>, icon: '🚫', onClick: () => ignore(dir) },
      ext && { label: <>Ignore all <span className="mono">*.{ext}</span></>, icon: "🚫", onClick: () => ignore(`*.${ext}`) },
      '-',
      keptCount > 0 && { label: show === 'kept' ? 'Hide files the sync leaves alone' : `Show ${plural(keptCount, 'file')} the sync leaves alone`, icon: '⌂', onClick: () => setShow(show === 'kept' ? 'all' : 'kept') },
    ];
  };
  const projectMenu = (p: any): MenuItem[] => {
    const dir = sourceDir(p);
    return [
      p.id !== project?.id && { label: 'Open', icon: '▣', onClick: () => pickProject(p.id) },
      ...localFileItems(dir, true),
      dir && { label: 'Edit .sshrmignore', icon: '🚫', title: 'Paths left out of sync and checks', onClick: () => say(window.api.openIgnoreFile(dir).then((r) => (r === true ? null : Promise.reject(new Error(r === 'missing' ? 'The source folder is not on this PC' : r))))) },
      copyItem('Copy folder path', dir),
      '-',
      { label: 'New mapping…', icon: '＋', onClick: () => { setMenu(null); setAdding(''); } },
      '-',
      { label: 'Remove project…', icon: '🗑', danger: true, onClick: async () => {
        if (!confirm(`Remove the project "${p.name}" and all its host mappings?\n\nMetadata only: no folder on any machine is touched.`)) return;
        try { await call('removeProject', { project_id: p.id, expected_revision: p.revision }); setMenu(null); reload(); } catch (e) { setErr(errText(e)); }
      } },
    ];
  };
  const destMenu = (l: any): MenuItem[] => {
    const h = hosts.find((x) => x.id === l.host_id), name = h?.name ?? 'host', cur = l.id === dest?.id, path = l.canonical_path ?? l.path_input;
    return [
      !cur && { label: 'Select', icon: '✓', onClick: () => pickDest(l.id) },
      cur && !!l.path_input && { label: 'Refresh', icon: '⟳', disabled: !!busy, onClick: () => { setMenu(null); check(); } },
      cur && exec && { label: `Sync to ${name}`, icon: '⇡', disabled: !!busy, onClick: () => { setMenu(null); sync(); } },
      '-',
      path && { label: `Open folder on ${name}`, icon: '🖥', onClick: () => say(openOnHost(l.host_id, path)) },
      copyItem(`Copy path on ${name}`, path),
      { label: `Open ${name}'s page`, icon: '↗', onClick: () => { setMenu(null); onOpenHost(l.host_id); } },
      '-',
      { label: 'Remove mapping…', icon: '🗑', danger: true, onClick: async () => { try { if (await removeMapping(project, l, name)) { setMenu(null); reload(); } } catch (e) { setErr(errText(e)); } } },
    ];
  };
  const syncMenu = (s: any): MenuItem[] => [
    { label: 'Show details', icon: '☰', onClick: () => setSelSync(s.id) },
    '-',
    copyItem('Copy commit hash', s.head), copyItem('Copy branch', s.branch), copyItem('Copy operation id', s.operation_id),
    '-',
    { label: 'Check again now', icon: '⟳', disabled: !!busy || !dest?.path_input, onClick: () => { setTab('changes'); check(); } },
  ];

  const dialog = adding !== null && <MappingDialog hosts={hosts} hostId={adding} projects={projects} onClose={() => { setAdding(null); reload(); }} />;

  if (data && projects.length === 0) {
    return (
      <div className="gd-body"><main className="gd-main"><div className="gd-blank">
        <h1>No projects yet</h1>
        <p>Map a project folder on this PC to a folder on one of your hosts, then check and sync it from here.</p>
        <div className="gd-box"><div className="gd-row"><div><b>Add your first project mapping</b><div className="muted small">A mapping never copies anything until you press Sync.</div></div>
          <button className="primary" onClick={() => setAdding('')} disabled={!hosts.length}>New mapping</button></div></div>
        {!hosts.length && <p className="muted small">Add a host first (Hosts menu).</p>}
      </div></main>{dialog}</div>
    );
  }

  return (
    <div className="gd-body" style={{ '--side-w': `${sideW}px` } as React.CSSProperties}>
      {/* ── Toolbar ─────────────────────────────────────────── */}
      <div className="gd-toolbar">
        <ToolbarItem onContextMenu={(e) => project && openMenu(e, projectMenu(project), project.name)} icon="▣" label="Current project" value={project?.name ?? '…'} open={menu === 'project'} onClick={() => setMenu(menu === 'project' ? null : 'project')} />
        <ToolbarItem onContextMenu={(e) => dest && openMenu(e, destMenu(dest), hostName)} icon="🖥" label="Current destination" value={dest ? `${hostName}${dest.label && dest.label !== host?.name ? ` · ${dest.label}` : ''}` : 'None'} open={menu === 'dest'} onClick={() => setMenu(menu === 'dest' ? null : 'dest')} />
        <ToolbarItem onContextMenu={(e) => openMenu(e, [copyItem('Copy branch name', pre?.summary.source.branch ?? source?.last_inspection?.branch), copyItem('Copy commit hash', pre?.summary.source.head ?? source?.last_inspection?.head)])} icon="⑂" label="Current branch" value={branch} />
        <ToolbarItem icon={busy === 'check' ? '◌' : '⟳'} label="" value={busy === 'check' ? `Refreshing…` : `Refresh`} sub={checkedAt ? `Checked ${age(checkedAt)} · this PC and ${hostName}` : 'Not checked yet'}
          onClick={check} disabled={!!busy || !dest?.path_input} />
        {menu && <div className="gd-scrim" onClick={() => setMenu(null)} />}
        {menu === 'project' && (
          <div className="gd-pop" style={{ left: 0 }}>
            <div className="gd-pop-head"><input autoFocus placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} /><button onClick={() => { setMenu(null); setAdding(''); }}>New mapping</button></div>
            <div className="gd-pop-section">Projects</div>
            {projects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase())).map((p) => (
              <button key={p.id} className="gd-pop-item" onClick={() => pickProject(p.id)} onContextMenu={(e) => openMenu(e, projectMenu(p), p.name)}>
                <span className="gd-check">{p.id === project?.id ? '✓' : ''}</span><span className="grow-1 ellipsis">{p.name}</span>
                <span className="muted small">{plural(p.locations.filter((l: any) => l.role !== 'source').length, 'host')}</span>
              </button>
            ))}
          </div>
        )}
        {menu === 'dest' && (
          <div className="gd-pop" style={{ left: 'var(--side-w)' }}>
            <div className="gd-pop-head"><span className="grow-1 muted small ellipsis">{project?.name}</span><button onClick={() => { setMenu(null); setAdding(''); }}>New mapping</button></div>
            <div className="gd-pop-section">Source</div>
            <div className="gd-pop-item static" onContextMenu={(e) => openMenu(e, [...localFileItems(srcPath, true), copyItem('Copy folder path', srcPath)], 'This PC')}><span className="gd-check">💻</span><span className="grow-1">This PC</span><span className="muted small mono ellipsis">{srcPath}</span></div>
            <div className="gd-pop-section">Destinations</div>
            {dests.length === 0 && <div className="gd-pop-item static muted">Not mapped to any host yet.</div>}
            {dests.map((l) => {
              const h = hosts.find((x) => x.id === l.host_id);
              return (
                <button key={l.id} className="gd-pop-item" onClick={() => pickDest(l.id)} onContextMenu={(e) => openMenu(e, destMenu(l), h?.name ?? 'host')}>
                  <span className="gd-check">{l.id === dest?.id ? '✓' : ''}</span>
                  {h && <StatusDot s={h.status} />}
                  <span className="grow-1 ellipsis">{h?.name ?? 'unknown host'}{l.label && l.label !== h?.name ? ` · ${l.label}` : ''}</span>
                  <span className="muted small mono ellipsis">{l.path_input ?? 'folder not set'}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="gd-split">
        {/* ── Sidebar: Changes / History ───────────────────── */}
        <aside className="gd-side">
          <div className="gd-tabs">
            <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>Changes{changeCount ? <span className="gd-count">{changeCount}</span> : null}</button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History</button>
          </div>
          {tab === 'changes' ? (
            <>
              <div className="gd-list-head">{pre ? plural(allRows.length - keptCount, 'changed file') : busy === 'check' ? 'Checking…' : 'Not checked yet'}</div>
              {pre && allRows.length > keptCount && (
                <div className="gd-seg" role="radiogroup" aria-label="Show files">
                  {([['all', 'All', allRows.length - keptCount, 'Every file the sync would change or is blocked by'], ['dirty', 'Host edits', dirtyCount, `Edited on ${hostName} and this PC doesn't have that version: Sync won't overwrite them`],
                    ['clean', 'From this PC', allRows.length - dirtyCount - keptCount, `${hostName} just has an older copy: Sync replaces it`]] as const).map(([k, label, n, tip]) => (
                    <button key={k} role="radio" aria-checked={show === k} className={show === k ? 'on' : ''} title={tip} onClick={() => setShow(k)}>{label} <span className="gd-seg-n">{n}</span></button>
                  ))}
                </div>
              )}
              {dirtyCount > 0 && <div className="gd-list-hint">! = edited on {hostName}; this PC doesn't have that version. Sync won't overwrite it unless you back it up first.</div>}
              {keptCount > 0 && <button className="gd-list-hint link" onClick={() => setShow(show === 'kept' ? 'all' : 'kept')} title="Files only on the host, or host edits to files this PC hasn't changed: Sync leaves them as they are">⌂ {show === 'kept' ? 'Hide' : 'Show'} {plural(keptCount, 'file')} on {hostName} the sync leaves alone</button>}
              <div className="gd-list">
                {commitLine && <div className="gd-file commit" onContextMenu={(e) => openMenu(e, [copyItem('Copy commit hash', pre.summary.source.head), copyItem('Copy branch', exec.branch), copyItem(`Copy ${hostName}'s commit hash`, pre.summary.destination.head)])} title={`${pre.summary.source.head} → ${hostName}`}><span className="grow-1 ellipsis">⊶ {commitLine} → {pre.summary.source.head?.slice(0, 7)}</span><span className="gd-mark A">⇡</span></div>}
                {rows.map((r) => (
                  <button key={r.p} className={`gd-file ${r.p === selFile ? 'sel' : ''}`} title={`${r.p}\n${r.t}`} onClick={() => setSelFile(r.p)} onContextMenu={(e) => { setSelFile(r.p); openMenu(e, fileMenu(r), r.p); }}>
                    <span className="gd-path"><span className="gd-dir">{r.p.slice(0, r.p.lastIndexOf('/') + 1)}</span><span className="gd-name">{r.p.slice(r.p.lastIndexOf('/') + 1)}</span></span>
                    {r.dirty && <span className="gd-mark dirty" title={`Edited on ${hostName}: this PC doesn't have that version`}>!</span>}
                    <span className={`gd-mark ${r.m}`} title={r.m === 'K' ? `Kept: ${hostName}'s edit stays` : undefined}>{r.m === 'M' ? '•' : r.m === 'A' ? '+' : r.m === 'K' ? '⌂' : '−'}</span>
                  </button>
                ))}
                {pre && allRows.length > keptCount && rows.length === 0 && <div className="gd-list-empty">{show === 'dirty' ? 'No host edits.' : 'Nothing that only this PC changed.'}</div>}
              </div>
              {/* GitHub Desktop's commit box → the sync box */}
              <div className="gd-commit">
                <div className="gd-commit-sum">{exec ? [commitLine, exec.copy.length ? plural(exec.copy.length, 'uncommitted file') : ''].filter(Boolean).join(' + ') : pre ? (pre.verdict === 'ready' ? 'Already in sync' : pre.can_back_up ? `${plural(dirtyCount, 'host edit')} in the way` : 'Sync now can’t run this safely') : 'Check the host first'}</div>
                <div className="gd-commit-desc">{pre ? <>This PC <b>{pre.summary.source.branch ?? 'no git'}</b> {pre.summary.source.head?.slice(0, 7)} → {hostName} <b>{pre.summary.destination.branch ?? (pre.summary.destination.head ? 'detached' : 'no git')}</b> {pre.summary.destination.head?.slice(0, 7)}</> : <span className="muted">Fast-forward only. Work on the host is never overwritten.</span>}</div>
                <button className="primary gd-wide" disabled={(!exec && !pre?.can_back_up) || !!busy} onClick={() => sync(!exec)} title="Runs the plan over SSH, then re-reads both sides to verify">
                  {busy === 'sync' ? 'Syncing…' : !exec && pre?.can_back_up ? <>Back up {dirtyCount} &amp; sync</> : <>Sync to <b>{hostName}</b></>}
                </button>
              </div>
            </>
          ) : (
            <div className="gd-list">
              {syncs.length === 0 && <div className="gd-list-head">No syncs recorded yet</div>}
              {syncs.map((s) => {
                const o = OUTCOME[s.outcome] ?? { icon: '?', cls: '', text: s.outcome };
                return (
                  <button key={s.id} className={`gd-hist ${s.id === selSync ? 'sel' : ''}`} onClick={() => setSelSync(s.id)} onContextMenu={(e) => { setSelSync(s.id); openMenu(e, syncMenu(s)); }}>
                    <span className="gd-hist-title ellipsis"><span className={`gd-oc ${o.cls}`}>{o.icon}</span> {s.transfer_mode === 'gui_sync' ? 'Sync now' : s.transfer_mode ? `Transfer (${s.transfer_mode})` : 'Agent transfer'}{s.branch ? ` · ${s.branch}` : ''}</span>
                    <span className="gd-hist-sub">{s.head ? `${s.head.slice(0, 7)} · ` : ''}{o.text} · {age(s.started_at)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </aside>
        <div className="gd-resize" onMouseDown={startResize} onDoubleClick={() => { setSideW(260); store.set('sideW', '260'); }} title="Drag to resize · double-click to reset" />

        {/* ── Main pane ────────────────────────────────────── */}
        <main className="gd-main">
          {tab === 'changes' && selRow ? (
            <FileDiff key={selRow.p} projectId={project.id} destId={dest.id} row={selRow} hostName={hostName} onClose={() => setSelFile(null)} onMenu={(e) => openMenu(e, fileMenu(selRow), selRow.p)} />
          ) : tab === 'history' ? (
            selected ? <SyncDetail s={selected} /> : <div className="gd-blank"><h1>History</h1><p className="muted">Every verification after a transfer to {hostName} is listed on the left: the commit it was checked against and whether both sides matched.</p></div>
          ) : (
            <div className="gd-blank">
              <Err e={err} />
              {note && <div className="success">✓ {note}</div>}
              {!dest ? (
                <><h1>Not mapped yet</h1><p>{project?.name} has no destination host.</p>
                  <div className="gd-box"><div className="gd-row"><div><b>Map this project to a host</b><div className="muted small">Pick a host and a folder on it.</div></div><button onClick={() => setAdding('')}>New mapping</button></div></div></>
              ) : !dest.path_input ? (
                <><h1>No destination folder</h1><p>The folder on {hostName} is not set yet.</p>
                  <div className="gd-box"><div className="gd-row"><div><b>Choose the folder on {hostName}</b><div className="muted small">Edit the mapping on the host page.</div></div><button onClick={() => onOpenHost(dest.host_id)}>Open {hostName}</button></div></div></>
              ) : (
                <>
                  <h1>{!pre ? (busy === 'check' ? `Checking ${hostName}…` : 'Not checked yet') : exec ? `${plural(changeCount, 'change')} ready to sync` : pre.verdict === 'ready' ? 'No changes to sync' : 'Sync is blocked'}</h1>
                  <p>{!pre ? 'Reads both folders over SSH. Nothing is changed.' : pre.verdict === 'ready' && !exec ? `${hostName} matches this PC (${pre.summary.source.branch ?? 'no branch'} ${pre.summary.source.head?.slice(0, 7) ?? ''}). Here are some friendly suggestions for what to do next.` : exec ? `Sync carries this PC's work to ${hostName}, then re-reads both sides to verify.` : `${hostName} has work that Sync won't overwrite.`}</p>
                  {exec && (
                    <div className="gd-box blue"><div className="gd-row"><div><b>Sync your changes to {hostName}</b><div>{commitLine ? `${commitLine}${exec.copy.length ? ` and copy ${plural(exec.copy.length, 'uncommitted file')}` : ''}.` : `Copy ${plural(exec.copy.length, 'file')}.`}</div>
                      <div className="muted small">Fast-forward only: if {hostName} has its own commits or edits, Git refuses and nothing is overwritten.</div></div>
                      <button className="primary" disabled={!!busy} onClick={() => sync()}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button></div></div>
                  )}
                  {pre && !exec && pre.verdict !== 'ready' && (
                    <div className="gd-box amber">
                      <b>Why it can't sync: {pre.verdict.replaceAll('_', ' ')}</b>
                      <ul>{pre.facts.filter((f: any) => f.blocking).map((f: any, i: number) => <li key={i}>{f.detail}</li>)}</ul>
                      {pre.can_back_up ? (
                        <div className="gd-row"><div className="muted small">These are edits made on {hostName} that this PC doesn't have. Back them up into a git stash on {hostName} (get them back with <span className="mono">git stash pop</span>) and sync everything else.</div>
                          <button className="primary" disabled={!!busy} onClick={() => sync(true)}>{busy === 'sync' ? 'Syncing…' : `Back up ${dirtyCount} & sync`}</button></div>
                      ) : <div className="muted small">Resolve it on {hostName} (commit or discard the work there), then press Refresh. Your AI agent can also follow the plan below.</div>}
                    </div>
                  )}
                  <div className="gd-box list">
                    <div className="gd-row"><div><b>Open the project in your external editor</b><div className="muted small mono ellipsis">{srcPath}</div></div><button onClick={() => window.api.openInVscode(srcPath)}>Open in Visual Studio Code</button></div>
                    <div className="gd-row"><div><b>View the files of your project in Explorer</b></div><button onClick={() => window.api.showFolder(srcPath)}>Show in Explorer</button></div>
                    <div className="gd-row"><div><b>Open the folder on {hostName}</b><div className="muted small mono ellipsis">{destPath}</div></div><HostOpenButton hostId={dest.host_id} path={destPath} /></div>
                    <div className="gd-row"><div><b>Manage this mapping</b><div className="muted small">Change folders, confirm identity or remove it on the host page.</div></div><button onClick={() => onOpenHost(dest.host_id)}>Open {hostName}</button></div>
                  </div>
                  {pre && (
                    <details className="gd-plan">
                      <summary>Plan for agents ({kind?.replaceAll('_', ' ')}) · source snapshot {pre.source_snapshot}</summary>
                      <ol className="small">{pre.suggested_plan.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
                    </details>
                  )}
                </>
              )}
            </div>
          )}
        </main>
      </div>
      {dialog}
      {menuNode}
    </div>
  );
}

type FileRow = { p: string; m: 'M' | 'A' | 'D' | 'K'; dirty: boolean; t: string };
type DiffLine = { k: 'hunk' | 'add' | 'del' | 'ctx'; o?: number; n?: number; t: string };

function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0; let n = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('@@')) { const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l); o = Number(m?.[1] ?? 0); n = Number(m?.[2] ?? 0); out.push({ k: 'hunk', t: l }); }
    else if (l.startsWith('+')) out.push({ k: 'add', n: n++, t: l.slice(1) });
    else if (l.startsWith('-')) out.push({ k: 'del', o: o++, t: l.slice(1) });
    else if (l.startsWith(' ')) out.push({ k: 'ctx', o: o++, n: n++, t: l.slice(1) });
  }
  return out;
}

/** GitHub Desktop's diff view: the host's copy is the old side (−), this PC is the new side (+). */
function FileDiff({ projectId, destId, row, hostName, onClose, onMenu }: { projectId: string; destId: string; row: FileRow; hostName: string; onClose: () => void; onMenu: (e: React.MouseEvent) => void }) {
  const [d, setD] = useState<any>(null);
  const [lineMenu, openLineMenu] = useMenu();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { call('diffProjectFile', { project_id: projectId, destination_location_id: destId, path: row.p }).then(setD, (e) => setErr(errText(e))); }, [projectId, destId, row.p]);
  const lines = d?.diff ? parseDiff(d.diff) : d?.text != null ? d.text.split('\n').map((t: string, i: number) => ({ k: 'ctx', o: i + 1, n: i + 1, t })) : [];
  const shown = lines.slice(0, 6000);
  const adds = lines.filter((l: DiffLine) => l.k === 'add').length;
  const dels = lines.filter((l: DiffLine) => l.k === 'del').length;
  const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
  return (
    <div className="gd-diff">
      <div className="gd-diff-head">
        <span className="gd-path"><span className="gd-dir">{row.p.slice(0, row.p.lastIndexOf('/') + 1)}</span><span className="gd-name">{row.p.slice(row.p.lastIndexOf('/') + 1)}</span></span>
        {d?.diff && <span className="gd-diff-stat"><span className="add">+{adds}</span> <span className="del">−{dels}</span></span>}
        <button className="ghost" onClick={onMenu} onContextMenu={onMenu} title="Open, Show in Explorer, copy path, ignore…">⋯</button>
        <button className="ghost" onClick={onClose} title="Back to overview">✕</button>
      </div>
      <div className={`gd-diff-sub ${row.dirty ? 'dirty' : ''}`}>{row.dirty ? '! ' : ''}{row.t} <span className="muted">· <span className="del">−</span> {hostName} · <span className="add">+</span> this PC</span></div>
      <div className="gd-diff-body">
        {err && <div className="gd-diff-note"><Err e={err} /></div>}
        {!d && !err && <div className="gd-diff-note muted">Reading the file on both sides…</div>}
        {d?.binary && <div className="gd-diff-note">Binary file: no preview. This PC {d.source.exists ? size(d.source.size) : 'missing'} · {hostName} {d.destination.exists ? size(d.destination.size) : 'missing'}.</div>}
        {d?.too_large && <div className="gd-diff-note">Too large to preview (over 512 KB). This PC {d.source.exists ? size(d.source.size) : 'missing'} · {hostName} {d.destination.exists ? size(d.destination.size) : 'missing'}.</div>}
        {d?.diff === '' && <div className="gd-diff-note">Same content on both sides (differs only in file mode or line endings).</div>}
        {d?.text != null && <div className="gd-diff-note muted">Identical on both sides.</div>}
        {shown.length > 0 && (
          <table className="gd-diff-table"><tbody>
            {shown.map((l: DiffLine, i: number) => l.k === 'hunk'
              ? <tr key={i} className="hunk"><td className="ln" /><td className="ln" /><td className="code">{l.t}</td></tr>
              : <tr key={i} className={l.k} onContextMenu={(e) => openLineMenu(e, [copyItem('Copy selection', window.getSelection()?.toString().trim()), copyItem('Copy line', l.t || ' '), copyItem('Copy whole diff', d?.diff ?? d?.text), '-', copyItem('Copy file path', row.p)])}><td className="ln">{l.o ?? ''}</td><td className="ln">{l.n ?? ''}</td><td className="code"><span className="sign">{l.k === 'add' ? '+' : l.k === 'del' ? '−' : ' '}</span>{l.t}</td></tr>)}
          </tbody></table>
        )}
        {lines.length > shown.length && <div className="gd-diff-note muted">{lines.length - shown.length} more lines not shown.</div>}
      </div>
      {lineMenu}
    </div>
  );
}

/** VS Code Remote-SSH when the host has an ssh alias (key hosts); otherwise copy an ssh command that opens a shell in the folder. */
function HostOpenButton({ hostId, path }: { hostId: string; path: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const h = usePoll(() => call('getHost', { host_id: hostId }), [hostId], 30_000).data;
  if (h?.ssh_alias) return <button onClick={() => window.api.openInVscode(path, h.ssh_alias)}>Open in VS Code (Remote)</button>;
  return (
    <button onClick={async () => {
      const r = await call('connectionRecipe', { host_id: hostId, caller_environment: navigator.userAgent.includes('Windows') ? 'windows-native' : 'posix-native' });
      await copy(r.display); setMsg('Copied'); setTimeout(() => setMsg(null), 1500);
    }}>{msg ?? 'Copy SSH command'}</button>
  );
}

function SyncDetail({ s }: { s: any }) {
  const o = OUTCOME[s.outcome] ?? { icon: '?', cls: '', text: s.outcome };
  return (
    <div className="gd-detail">
      <h2>{s.transfer_mode === 'gui_sync' ? 'Sync now' : 'Transfer'}{s.branch ? ` · ${s.branch}` : ''}</h2>
      <div className="gd-detail-meta">
        <span className={`gd-oc ${o.cls}`}>{o.icon} {o.text}</span>
        {s.head && <span className="mono">⊶ {s.head.slice(0, 7)}</span>}
        <span>{new Date(s.started_at).toLocaleString()}</span>
        {s.evidence?.verdict && <span className={`badge v-${s.evidence.verdict}`}>{s.evidence.verdict.replaceAll('_', ' ')}</span>}
      </div>
      {s.evidence?.reason && <p>{s.evidence.reason}</p>}
      {(s.evidence?.facts ?? []).length > 0 && (
        <ul className="gd-facts">{s.evidence.facts.map((f: any, i: number) => (
          <li key={i} className={f.blocking ? '' : 'muted'}><b>{f.kind.replaceAll('_', ' ')}</b>: {f.detail}{f.paths?.length ? <div className="mono small">{f.paths.slice(0, 20).join('  ')}{f.paths.length > 20 ? ' …' : ''}</div> : null}</li>
        ))}</ul>
      )}
      <p className="muted small">Operation {s.operation_id}</p>
    </div>
  );
}

function MappingDialog({ hosts, hostId, projects, onClose }: { hosts: HostSummary[]; hostId: string; projects: any[]; onClose: () => void }) {
  const [hid, setHid] = useState(hostId || hosts[0]?.id || '');
  const h = usePoll(() => (hid ? call('getHost', { host_id: hid }) : Promise.resolve(null)), [hid], 60_000).data;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row"><b>New mapping</b><span className="grow" /><button className="ghost" onClick={onClose}>✕</button></div>
        <L t="Host"><select value={hid} onChange={(e) => setHid(e.target.value)}>{hosts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></L>
        {h && <NewMapping key={h.id} host={h} projects={projects} onDone={onClose} />}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Hosts List
// ═══════════════════════════════════════════════════════════

function HostList({ onOpen, onAdd, onEdit }: { onOpen: (id: string) => void; onAdd: () => void; onEdit: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const { data, error, reload } = usePoll(() => call<{ hosts: HostSummary[] }>('listHosts', { query: query || undefined, limit: 100 }), [query]);
  const settings = usePoll(() => call<{ gui_auto_check: boolean }>('getSettings'), [], 10_000).data;
  const running = useRef(new Set<string>());

  // Context menu & action states
  const [menuNode, openMenu] = useMenu();
  const [renameTarget, setRenameTarget] = useState<HostSummary | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [dupTarget, setDupTarget] = useState<HostSummary | null>(null);
  const [dupInput, setDupInput] = useState('');
  const [dupCopyPassword, setDupCopyPassword] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<HostSummary | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    if (!settings?.gui_auto_check || !data) return;
    const t = setInterval(() => {
      for (const h of data.hosts.filter((x) => x.enabled && x.status.stale && x.status.state !== 'checking')) {
        if (running.current.size >= 2 || running.current.has(h.id)) continue;
        running.current.add(h.id);
        setTimeout(() => checkHost(h.id).catch(() => {}).finally(() => running.current.delete(h.id)), Math.random() * 5000);
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [settings?.gui_auto_check, data]);

  // Escape closes the dialogs (the menu closes itself)
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setRenameTarget(null); setDupTarget(null); setDeleteTarget(null); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const done = (m: string) => { setActionErr(null); setActionSuccess(m); setTimeout(() => setActionSuccess(null), 3000); };
  const act = (p: Promise<unknown>) => p.then((m) => typeof m === 'string' && done(m), (e) => setActionErr(errText(e))).finally(reload);
  const openContextMenu = (e: React.MouseEvent, h: HostSummary) => openMenu(e, [
    { label: 'Open', icon: '↗', onClick: () => onOpen(h.id) },
    { label: 'Check now', icon: '⟳', onClick: () => act(checkHost(h.id).then((r) => (r.success ? `${h.name} is reachable${r.key_auth ? ` · ${r.key_auth}` : ''}` : Promise.reject(new Error(`${r.error?.code}: ${r.error?.message}`))))) },
    '-',
    { label: 'Copy SSH command', icon: '📋', onClick: () => act(call('connectionRecipe', { host_id: h.id, caller_environment: ENV }).then((r) => copy(r.display)).then(() => 'SSH command copied')) },
    { label: 'Copy scp template', icon: '📋', onClick: () => act(call('connectionRecipe', { host_id: h.id, caller_environment: ENV, purpose: 'file_transfer' }).then((r) => copy(r.display)).then(() => 'scp template copied')) },
    copyItem('Copy address', h.active_address ?? h.target),
    { label: 'Open in VS Code (Remote)', icon: '⌨', onClick: () => act(call('getHost', { host_id: h.id }).then((x) => openOnHost(h.id, x.default_remote_directory || '~'))) },
    '-',
    { label: 'Edit Host', icon: '✏️', onClick: () => onEdit(h.id) },
    { label: 'Rename…', icon: '🏷️', onClick: () => { setRenameTarget(h); setRenameInput(h.name); } },
    { label: 'Duplicate Host…', icon: '📋', onClick: () => { setDupTarget(h); setDupInput(`${h.name} (Copy)`); setDupCopyPassword(true); } },
    { label: h.enabled ? 'Disable' : 'Enable', icon: h.enabled ? '⏸' : '▶', onClick: () => act(call('updateHost', { host_id: h.id, expected_revision: h.revision, patch: { metadata: { enabled: !h.enabled } }, idempotency_key: idem() }).then(() => `${h.name} ${h.enabled ? 'disabled' : 'enabled'}`)) },
    '-',
    { label: 'Delete Host…', icon: '🗑️', danger: true, onClick: () => setDeleteTarget(h) },
  ], h.name);

  const handleRename = async () => {
    if (!renameTarget || !renameInput.trim()) return;
    setActionBusy(true);
    setActionErr(null);
    try {
      await call('updateHost', {
        host_id: renameTarget.id,
        expected_revision: renameTarget.revision,
        patch: { metadata: { name: renameInput.trim() } },
        idempotency_key: idem(),
      });
      setActionSuccess(`Host renamed to "${renameInput.trim()}"`);
      setTimeout(() => setActionSuccess(null), 3000);
      setRenameTarget(null);
      reload();
    } catch (e) {
      setActionErr(errText(e));
    } finally {
      setActionBusy(false);
    }
  };

  const handleDuplicate = async () => {
    if (!dupTarget || !dupInput.trim()) return;
    setActionBusy(true);
    setActionErr(null);
    try {
      await call('duplicateHost', {
        host_id: dupTarget.id,
        new_name: dupInput.trim(),
        copy_password: dupCopyPassword,
        idempotency_key: idem(),
      });
      setActionSuccess(`Host "${dupInput.trim()}" successfully duplicated!`);
      setTimeout(() => setActionSuccess(null), 4000);
      setDupTarget(null);
      reload();
    } catch (e) {
      setActionErr(errText(e));
    } finally {
      setActionBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setActionBusy(true);
    setActionErr(null);
    try {
      await call('removeHost', {
        host_id: deleteTarget.id,
        expected_revision: deleteTarget.revision,
      });
      setActionSuccess(`Host "${deleteTarget.name}" deleted.`);
      setTimeout(() => setActionSuccess(null), 3000);
      setDeleteTarget(null);
      reload();
    } catch (e) {
      setActionErr(errText(e));
    } finally {
      setActionBusy(false);
    }
  };

  const onlineCount = data?.hosts.filter(h => h.status.state === 'reachable').length ?? 0;
  const offlineCount = data?.hosts.filter(h => h.status.state === 'unreachable' || h.status.state === 'error').length ?? 0;
  const pendingCount = data?.hosts.filter(h => !['reachable', 'unreachable', 'error'].includes(h.status.state)).length ?? 0;

  return (
    <section>
      <div className="page-header">
        <h2>Hosts</h2>
        <div className="spacer" />
        <input className="search-input" placeholder="Search name, target, or description…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="primary" onClick={onAdd}>+ Add Host</button>
      </div>

      {data && data.hosts.length > 0 && (
        <div className="stat-cards">
          <div className="stat-card ok">
            <div className="stat-value">{onlineCount}</div>
            <div className="stat-label">Online</div>
          </div>
          <div className="stat-card bad">
            <div className="stat-value">{offlineCount}</div>
            <div className="stat-label">Offline / Error</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{pendingCount}</div>
            <div className="stat-label">Pending / Unknown</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{data.hosts.length}</div>
            <div className="stat-label">Total Hosts</div>
          </div>
        </div>
      )}

      <Err e={actionErr || error} />
      {actionSuccess && <div className="success">✓ {actionSuccess}</div>}

      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.hosts.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">🖥️</div>
          <p><b>No hosts registered yet</b></p>
          <p>Add one here, or ask your AI agent to register it through MCP.</p>
          <button className="primary" onClick={onAdd} style={{ marginTop: 12 }}>+ Add Your First Host</button>
        </div>
      )}
      {data && data.hosts.length > 0 && (
        <table className="host-table">
          <thead>
            <tr>
              <th>Host</th>
              <th>OS</th>
              <th>Target</th>
              <th>Status</th>
              <th>Capabilities</th>
              <th style={{ width: 44, textAlign: 'center' }}></th>
            </tr>
          </thead>
          <tbody>
            {data.hosts.map((h) => (
              <tr
                key={h.id}
                onClick={() => onOpen(h.id)}
                onContextMenu={(e) => openContextMenu(e, h)}
                className={`click ${h.enabled ? '' : 'dim'}`}
                title="Click to view details · Right-click for options"
              >
                <td>
                  <span className="host-name">{h.name}</span>
                  <div className="id">{h.id.slice(0, 8)}</div>
                </td>
                <td>{h.declared_os} / {h.observed_os ?? '—'} {h.os_mismatch && <span className="badge warn">mismatch</span>}</td>
                <td className="mono">{h.target}{h.active_address && <span className="muted"> → {h.active_address}</span>}</td>
                <td><Badge s={h.status} /></td>
                <td>{h.capability_keys.slice(0, 4).join(', ')}{h.capability_keys.length > 4 ? ` +${h.capability_keys.length - 4}` : ''}</td>
                <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="ghost"
                    style={{ padding: '2px 8px', fontSize: '16px', lineHeight: 1 }}
                    title="Options (Right-click)"
                    onClick={(e) => openContextMenu(e, h)}
                  >
                    ⋮
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {menuNode}

      {/* ── Rename Modal ────────────────────────────────────────── */}
      {renameTarget && (
        <div className="modal-back" onClick={() => !actionBusy && setRenameTarget(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h3>Rename Host</h3>
              <span className="grow" />
              <button className="ghost" disabled={actionBusy} onClick={() => setRenameTarget(null)}>✕</button>
            </div>
            <p className="muted small">Change display name for <b className="mono">{renameTarget.target}</b></p>
            <div className="field" style={{ marginTop: 12 }}>
              <span>Host Display Name</span>
              <input
                autoFocus
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
              />
            </div>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button disabled={actionBusy} onClick={() => setRenameTarget(null)}>Cancel</button>
              <button className="primary" disabled={actionBusy || !renameInput.trim() || renameInput.trim() === renameTarget.name} onClick={handleRename}>
                {actionBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Duplicate Modal ────────────────────────────────────────── */}
      {dupTarget && (
        <div className="modal-back" onClick={() => !actionBusy && setDupTarget(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18 }}>📋</span>
                <h3>Duplicate Host</h3>
              </div>
              <span className="grow" />
              <button className="ghost" disabled={actionBusy} onClick={() => setDupTarget(null)}>✕</button>
            </div>
            <p className="muted small">
              Clone <b>{dupTarget.name}</b> (<span className="mono">{dupTarget.target}</span>). Profile, connection options, OS settings, and capabilities will be copied into a new host.
            </p>
            <div className="field" style={{ marginTop: 12 }}>
              <span>New Host Name</span>
              <input
                autoFocus
                value={dupInput}
                onChange={(e) => setDupInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleDuplicate(); }}
                placeholder="e.g. My Host (Copy)"
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={dupCopyPassword}
                onChange={(e) => setDupCopyPassword(e.target.checked)}
              />
              <span className="small">Copy stored credentials (passwords will be securely encrypted for new host)</span>
            </label>
            <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
              <button disabled={actionBusy} onClick={() => setDupTarget(null)}>Cancel</button>
              <button className="primary" disabled={actionBusy || !dupInput.trim()} onClick={handleDuplicate}>
                {actionBusy ? 'Duplicating…' : 'Duplicate Host'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Modal ────────────────────────────────────────── */}
      {deleteTarget && (
        <div className="modal-back" onClick={() => !actionBusy && setDeleteTarget(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h3 style={{ color: 'var(--bad)' }}>Delete Host</h3>
              <span className="grow" />
              <button className="ghost" disabled={actionBusy} onClick={() => setDeleteTarget(null)}>✕</button>
            </div>
            <p style={{ marginTop: 8 }}>
              Are you sure you want to delete <b>{deleteTarget.name}</b> (<span className="mono">{deleteTarget.target}</span>)?
            </p>
            <p className="muted small" style={{ marginTop: 6 }}>
              Only the local registry record is deleted. Remote machines, SSH keys, and config files will not be touched.
            </p>
            <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
              <button disabled={actionBusy} onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="danger" disabled={actionBusy} onClick={handleDelete}>
                {actionBusy ? 'Deleting…' : 'Delete Host'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════
// Host Form
// ═══════════════════════════════════════════════════════════

type FormState = {
  mode: 'direct' | 'ssh_alias'; auth: 'key' | 'password'; password: string; hostname: string; alternates: string; port: string; username: string; identity_file: string; identities_only: boolean; proxy_jump: string;
  alias: string; config_path: string; name: string; declared_os: string; description: string; instructions: string; tags: string; default_remote_directory: string; caps: string; enabled: boolean;
};
const emptyForm: FormState = { mode: 'direct', auth: 'key', password: '', hostname: '', alternates: '', port: '22', username: '', identity_file: '', identities_only: false, proxy_jump: '', alias: '', config_path: '',
  name: '', declared_os: 'unknown', description: '', instructions: '', tags: '', default_remote_directory: '', caps: '', enabled: true };

function HostForm({ hostId, onDone }: { hostId: string | null; onDone: (id: string | null) => void }) {
  const [f, setF] = useState<FormState>(emptyForm);
  const [rev, setRev] = useState<number | null>(null);
  const [origCaps, setOrigCaps] = useState<string[]>([]);
  const [stored, setStored] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [imp, setImp] = useState({ text: '', shell: 'powershell' });
  const [preview, setPreview] = useState<{ ok: boolean; draft: Record<string, any> | null; warnings: string[]; errors: string[]; missing_fields: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(idem());

  const load = useCallback(async () => {
    if (!hostId) return;
    const h = await call('getHost', { host_id: hostId });
    const p = h.profile;
    setF({ ...emptyForm, mode: p.mode, auth: p.auth ?? 'key', hostname: p.hostname ?? '', alternates: (p.alternate_hostnames ?? []).join(', '), port: String(p.port ?? 22), username: p.username ?? '', identity_file: p.identity_file ?? '',
      identities_only: !!p.identities_only, proxy_jump: (p.proxy_jump ?? []).join(','), alias: p.alias ?? '', config_path: p.config_path ?? '',
      name: h.name, declared_os: h.declared_os, description: h.description, instructions: h.instructions, tags: h.tags.join(', '),
      default_remote_directory: h.default_remote_directory ?? '', enabled: h.enabled,
      caps: h.capabilities.map((c: any) => `${c.key}${c.label ? ` | ${c.label}` : ''}`).join('\n') });
    setOrigCaps(h.capabilities.map((c: any) => c.key));
    setStored(h.password_stored);
    setRev(h.revision);
    setConflict(false);
    key.current = idem();
  }, [hostId]);
  useEffect(() => { load().catch((e) => setErr(errText(e))); }, [load]);

  const set = (k: keyof FormState) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const profile = () => f.mode === 'ssh_alias'
    ? { mode: 'ssh_alias', alias: f.alias.trim(), auth: f.auth, ...(f.config_path ? { config_path: f.config_path } : {}) }
    : { mode: 'direct', hostname: f.hostname.trim(), port: Number(f.port), username: f.username.trim(), auth: f.auth, identities_only: f.identities_only,
      ...(f.alternates.trim() ? { alternate_hostnames: f.alternates.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(f.identity_file ? { identity_file: f.identity_file } : {}), ...(f.proxy_jump ? { proxy_jump: f.proxy_jump.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(f.config_path ? { config_path: f.config_path } : {}) };
  const caps = () => f.caps.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [k, ...rest] = l.split('|'); return { key: k.trim(), label: rest.join('|').trim() }; });
  const metadata = () => ({ name: f.name, enabled: f.enabled, declared_os: f.declared_os, description: f.description, instructions: f.instructions,
    tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), default_remote_directory: f.default_remote_directory || null });

  async function save(andCheck: boolean) {
    setErr(null); setBusy(true);
    try {
      let id: string;
      if (!hostId) {
        id = (await call('registerHost', { profile: profile(), metadata: metadata(), capabilities: caps(), idempotency_key: key.current })).host.id;
      } else {
        const c = caps();
        await call('updateHost', { host_id: hostId, expected_revision: rev, idempotency_key: key.current,
          patch: { profile: profile(), metadata: metadata(), capabilities: { upsert: c, remove: origCaps.filter((k) => !c.some((x) => x.key === k)) } } });
        id = hostId;
      }
      if (f.auth === 'password' && f.password) await call('setHostPassword', { host_id: id, password: f.password });
      if (andCheck) await checkHost(id).catch(() => {});
      onDone(id);
    } catch (e) {
      if (e instanceof CallError && e.error.code === 'REVISION_CONFLICT') setConflict(true);
      setErr(errText(e));
      key.current = idem();
    } finally { setBusy(false); }
  }

  async function doPreview() {
    setPreview(await call('parseConnectionInput', { text: imp.text, source_shell: imp.shell }));
  }
  function useDraft() {
    const d = preview?.draft;
    if (!d) return;
    setF({ ...f, mode: d.mode, hostname: d.hostname ?? '', port: String(d.port ?? 22), username: d.username ?? '', identity_file: d.identity_file ?? '',
      identities_only: !!d.identities_only, proxy_jump: (d.proxy_jump ?? []).join(','), alias: d.alias ?? '', config_path: d.config_path ?? '', name: f.name || (d.hostname ?? d.alias ?? '') });
  }

  return (
    <section className="form">
      <div className="page-header">
        <button className="ghost" onClick={() => onDone(hostId)}>← Back</button>
        <h2>{hostId ? 'Edit Host' : 'Add Host'}</h2>
      </div>
      {conflict && <div className="error">This host was changed elsewhere (GUI or agent). Your edits were not saved. <button onClick={() => load()}>Reload latest</button></div>}
      <Err e={err} />
      {!hostId && (
        <fieldset>
          <legend>Import from SSH command</legend>
          <p className="muted small" style={{ marginBottom: 8 }}>Paste an ssh command to auto-fill fields. Pure parsing — no network, nothing is executed.</p>
          <div className="row">
            <input className="grow mono" placeholder='ssh -p 2222 -i "C:\keys\id_ed25519" dev@192.168.1.20' value={imp.text} onChange={(e) => setImp({ ...imp, text: e.target.value })} />
            <select value={imp.shell} onChange={(e) => setImp({ ...imp, shell: e.target.value })}><option>powershell</option><option>cmd</option><option>posix</option></select>
            <button onClick={doPreview} disabled={!imp.text}>Preview</button>
          </div>
          {preview && (
            <div className="preview">
              {preview.errors.map((x) => <div key={x} className="error">{x}</div>)}
              {preview.warnings.map((x) => <div key={x} className="warn">{x}</div>)}
              {preview.missing_fields.length > 0 && <div className="warn">Missing: {preview.missing_fields.join(', ')}</div>}
              {preview.draft && <><pre>{JSON.stringify(preview.draft, null, 2)}</pre><button onClick={useDraft}>Use this draft</button></>}
            </div>
          )}
        </fieldset>
      )}
      <fieldset>
        <legend>Connection</legend>
        <div className="row">
          <label><input type="radio" checked={f.mode === 'direct'} onChange={() => setF({ ...f, mode: 'direct' })} /> Direct</label>
          <label><input type="radio" checked={f.mode === 'ssh_alias'} onChange={() => setF({ ...f, mode: 'ssh_alias' })} /> Existing ssh_config alias</label>
        </div>
        {f.mode === 'direct' ? (
          <div className="grid">
            <L t="Hostname / IP"><input value={f.hostname} onChange={set('hostname')} /></L>
            <L t="Other addresses of this machine (Wi-Fi, VPN; comma separated). Check uses the fastest that answers."><input value={f.alternates} onChange={set('alternates')} placeholder="10.8.0.5, 192.168.50.20" /></L>
            <L t="Port"><input value={f.port} onChange={set('port')} inputMode="numeric" /></L>
            <L t="Username"><input value={f.username} onChange={set('username')} /></L>
            <L t="Identity file (optional)"><input value={f.identity_file} onChange={set('identity_file')} /></L>
            <L t="ProxyJump aliases (comma separated)"><input value={f.proxy_jump} onChange={set('proxy_jump')} /></L>
            <L t="ssh config path (optional)"><input value={f.config_path} onChange={set('config_path')} /></L>
            <label><input type="checkbox" checked={f.identities_only} onChange={set('identities_only')} /> IdentitiesOnly</label>
          </div>
        ) : (
          <div className="grid">
            <L t="Alias (Host from your ssh config)"><input value={f.alias} onChange={set('alias')} /></L>
            <L t="ssh config path (optional)"><input value={f.config_path} onChange={set('config_path')} /></L>
            <p className="muted small">Aliases use your own ssh_config and known_hosts. This app never edits them.</p>
          </div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <span style={{ fontWeight: 500 }}>Authentication:</span>
          <label><input type="radio" checked={f.auth === 'key'} onChange={() => setF({ ...f, auth: 'key' })} /> SSH key / ssh-agent</label>
          <label><input type="radio" checked={f.auth === 'password'} onChange={() => setF({ ...f, auth: 'password' })} /> Username + password</label>
        </div>
        {f.auth === 'password' ? (
          <div className="grid">
            <L t={stored ? 'Password (stored — leave empty to keep)' : 'Password'}>
              <input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} placeholder={stored ? '••••••••' : ''} />
            </L>
            <p className="muted small">Encrypted with Windows DPAPI. Never shown again, never sent to AI agents, and deleted automatically if the host address/user changes.
              {stored && hostId && <> <button className="link" onClick={async () => { await call('clearHostPassword', { host_id: hostId }); setStored(false); }}>Forget stored password</button></>}</p>
          </div>
        ) : <p className="muted small">Uses keys loaded in ssh-agent or the identity file above. Private keys and passphrases are never stored.</p>}
      </fieldset>
      <fieldset>
        <legend>Description</legend>
        <div className="grid">
          <L t="Display name"><input value={f.name} onChange={set('name')} /></L>
          <L t="Declared OS"><select value={f.declared_os} onChange={set('declared_os')}>{['unknown', 'macos', 'linux', 'windows'].map((o) => <option key={o}>{o}</option>)}</select></L>
          <L t="Tags (comma separated)"><input value={f.tags} onChange={set('tags')} /></L>
          <L t="Default remote directory"><input value={f.default_remote_directory} onChange={set('default_remote_directory')} /></L>
          <label><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> Enabled</label>
        </div>
        <L t="Description"><textarea value={f.description} onChange={set('description')} rows={2} /></L>
        <L t="Instructions for agents"><textarea value={f.instructions} onChange={set('instructions')} rows={3} /></L>
        <L t="Capabilities — one per line: key | label"><textarea className="mono" value={f.caps} onChange={set('caps')} rows={3} /></L>
      </fieldset>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => save(false)}>Save</button>
        <button disabled={busy} onClick={() => save(true)}>Save & Check</button>
      </div>
    </section>
  );
}
const L = ({ t, children }: { t: string; children: ReactNode }) => <label className="field"><span>{t}</span>{children}</label>;

// ═══════════════════════════════════════════════════════════
// Signing Settings
// ═══════════════════════════════════════════════════════════

const SIGNING_MODES = [
  { mode: 'off', title: 'Off', text: 'Agents cannot sign over SSH. iPhone/release builds fail with errSecInternalComponent.' },
  { mode: 'login_keychain', title: 'Unlock the login keychain with the stored password',
    text: 'Simplest. Each signing build unlocks your login keychain in its own SSH session using the host password. That password also opens everything else in the login keychain.' },
  { mode: 'build_keychain', title: 'Separate build keychain (recommended)',
    text: 'Set up automatically once: your code-signing identity is copied into its own keychain with a random password. Builds unlock only that keychain; your login password is not used again.' },
];

function SigningSettings({ h, act, busy }: { h: any; act: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }) {
  const s = h.signing;
  const [p12pw, setP12pw] = useState('');
  const choose = (mode: string) => act(async () => {
    if (mode !== 'off' && !confirm(`${SIGNING_MODES.find((m) => m.mode === mode)!.title}?\n\nAI agents using this manager will then be able to code-sign on ${h.name} without asking you.`)) return;
    const r = await call('setSigningMode', { host_id: h.id, mode });
    if (r.needs_setup) await call('setupBuildKeychain', { host_id: h.id });
  });
  return (
    <>
      <h3>Code Signing over SSH</h3>
      <p className="muted small">macOS unlocks a keychain only for the SSH session that unlocked it. Agents run signing builds through the manager's runner, which unlocks it inside that same session. The secret never reaches the agent.</p>
      {SIGNING_MODES.map((m) => (
        <label key={m.mode} className="signing-mode">
          <input type="radio" name={`sign-${h.id}`} disabled={busy || (m.mode !== 'off' && !h.password_stored)} checked={s.mode === m.mode} onChange={() => choose(m.mode)} />
          <span><b>{m.title}</b><div className="muted small">{m.text}</div></span>
        </label>
      ))}
      {!h.password_stored && <div className="warn small">Store the host password first (Edit): both modes use it, the build keychain only once during setup.</div>}
      {s.mode === 'build_keychain' && (
        <div className="small">
          {s.build_keychain_secret_stored && s.build_keychain?.identities
            ? <>Build keychain ready ({age(s.build_keychain.set_up_at)}): {s.build_keychain.identities.map((i: any) => i.name).join(', ')}</>
            : <span className="warn">Build keychain not set up yet.{s.build_keychain?.last_error ? ` Last attempt: ${s.build_keychain.last_error}` : ''}</span>}
          {' '}<button disabled={busy} onClick={() => act(() => call('setupBuildKeychain', { host_id: h.id }))}>{s.build_keychain_secret_stored ? 'Set up again (after a certificate renewal)' : 'Set up now'}</button>
          {s.build_keychain?.needs_p12 && <div className="warnbox">macOS won't let the manager copy your signing key without a click on the Mac. Do this once: on the Mac open Keychain Access → login → My Certificates, right-click "Apple Development: …" → Export… as .p12 with a password, copy the file to this PC, then import it here.</div>}
          <div className="row">
            <input type="password" placeholder=".p12 password" value={p12pw} onChange={(e) => setP12pw(e.target.value)} />
            <button disabled={busy} onClick={() => act(async () => { const r = await window.api.importP12(h.id, p12pw); if (r && !r.ok) throw r.error; setP12pw(''); })}>Import .p12…</button>
          </div>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// Host Detail
// ═══════════════════════════════════════════════════════════

function HostDetail({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: () => void }) {
  const { data: h, error, reload } = usePoll(() => call('getHost', { host_id: id }), [id]);
  const hist = usePoll(() => call('hostHistory', { host_id: id, limit: 15 }), [id], 5000);
  const [err, setErr] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<any>(null);
  const [probes, setProbes] = useState('binary:git');
  const [busy, setBusy] = useState(false);
  const [menuNode, openMenu] = useMenu();
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      reload();
      hist.reload();
    }
  };
  if (error) return <section><button className="ghost" onClick={onBack}>← Back</button><Err e={error} /></section>;
  if (!h) return <p className="muted">Loading…</p>;
  const env = navigator.userAgent.includes('Windows') ? 'windows-native' : 'posix-native';
  return (
    <section>
      <div className="page-header">
        <button className="ghost" onClick={onBack}>← Hosts</button>
        <h2>{h.name}</h2>
        <Badge s={h.status} />
        <div className="spacer" />
        <button className="primary" disabled={busy} onClick={() => act(async () => { const r = await checkHost(id); setLastCheck(r); if (r.key_auth) setSuccessMsg(r.key_auth); })}>Check Now</button>
        <button onClick={onEdit}>Edit</button>
      </div>
      <div className="id">ID {h.id} · rev {h.revision} · identity gen {h.identity_generation}</div>
      <Err e={err} />
      {successMsg && <div className="success">✓ {successMsg}</div>}
      <div className="row">
        <button onClick={() => act(async () => { const r = await call('connectionRecipe', { host_id: id, caller_environment: env }); await copy(r.display); setSuccessMsg('SSH command copied to clipboard'); })}>📋 Copy SSH Command</button>
        <button onClick={() => act(async () => { const r = await call('connectionRecipe', { host_id: id, caller_environment: env, purpose: 'file_transfer' }); await copy(r.display); setSuccessMsg('scp template copied to clipboard'); })}>📋 Copy scp Template</button>
        <button onClick={() => act(() => call('updateHost', { host_id: id, expected_revision: h.revision, patch: { metadata: { enabled: !h.enabled } }, idempotency_key: idem() }))}>{h.enabled ? 'Disable' : 'Enable'}</button>
        <button className="danger" onClick={() => {
          if (confirm(`Remove "${h.name}" from this app?\n\nOnly the local record is deleted. Nothing on the remote machine, your SSH keys or ssh config is touched.`)) {
            act(async () => { await call('removeHost', { host_id: id, expected_revision: h.revision }); onBack(); });
          }
        }}>Remove</button>
      </div>
      {(h.status.state === 'trust_required' || h.status.state === 'host_key_changed') && !lastCheck?.trust_candidates && (
        <div className="error">
          {h.status.state === 'trust_required' ? 'This host\'s key is not trusted yet, so no login (password or key) is attempted.' : 'The host key CHANGED since it was trusted. Do not continue unless you know why.'}
          {' '}<button disabled={busy} onClick={() => act(async () => { const r = await checkHost(id); setLastCheck(r); if (r.key_auth) setSuccessMsg(r.key_auth); })}>Show fingerprint to verify</button>
        </div>
      )}
      {lastCheck?.trust_candidates && Array.isArray(lastCheck.trust_candidates) && (
        <fieldset className="trust">
          <legend>Host key not trusted yet</legend>
          <p>{lastCheck.trust_note}</p>
          {lastCheck.trust_candidates.map((c: any) => (
            <div key={c.fingerprint} className="row mono">
              {c.algorithm} {c.fingerprint}
              <button onClick={() => {
                if (confirm(`Trust ${c.algorithm} ${c.fingerprint}?\n\nOnly confirm if you compared it with the fingerprint shown ON the machine itself.`)) {
                  act(() => call('approveHostKey', { host_id: id, fingerprint: c.fingerprint, algorithm: c.algorithm, expected_identity_generation: h.identity_generation }));
                }
              }}>I verified this fingerprint</button>
            </div>
          ))}
        </fieldset>
      )}
      {h.status.warnings?.map((w: any) => <div key={w.code} className="warnbox"><b>{w.message}</b><div className="small">{w.fix}</div></div>)}
      {lastCheck && !lastCheck.success && <div className="error">{lastCheck.error?.code}: {lastCheck.error?.message}{lastCheck.error?.next_action ? ` — ${lastCheck.error.next_action}` : ''}</div>}
      <div className="cols">
        <div>
          <h3>Connection</h3>
          <pre>{JSON.stringify(h.profile, null, 2)}</pre>
          <p>OS: declared <b>{h.declared_os}</b>, observed <b>{h.observed_os ?? '—'}</b> {h.observed_os_detail && <span className="muted">({h.observed_os_detail})</span>} {h.os_mismatch && <span className="badge warn">mismatch</span>}</p>
          <p>Authentication: <b>{h.auth === 'password' ? 'username + password' : 'SSH key / agent'}</b>{h.auth === 'password' && (h.password_stored ? ' · password stored (encrypted)' : <span className="warn"> · no password stored — Edit to set it</span>)}
            {h.auth === 'password' && h.password_stored && h.profile.mode === 'direct' && <> <button disabled={busy} title="Generates an SSH key on this PC, installs it on the host using the stored password, tests a key-only login, then switches. The password stays stored."
              onClick={() => act(async () => { const r = await call('switchToKeyAuth', { host_id: id }); setSuccessMsg(r.note); })}>Switch to SSH key</button></>}
            {h.ssh_alias && <> · from any terminal: <span className="mono">ssh {h.ssh_alias}</span></>}</p>
          <p>Trusted keys: {h.trust.length ? h.trust.map((t: any, i: number) => <span key={t.fingerprint} onContextMenu={(e) => openMenu(e, [copyItem('Copy fingerprint', t.fingerprint), copyItem('Copy algorithm + fingerprint', `${t.algorithm} ${t.fingerprint}`)])}>{i ? '; ' : ''}<span className="mono">{t.algorithm} {t.fingerprint}</span> ({age(t.approved_at)})</span>) : h.profile.mode === 'ssh_alias' ? 'user-managed known_hosts' : 'none'}</p>
          <h3>Description</h3><p className="pre">{h.description || <span className="muted">—</span>}</p>
          <h3>Instructions</h3><p className="pre">{h.instructions || <span className="muted">—</span>}</p>
          {h.default_remote_directory && <p>Default remote directory: <span className="mono">{h.default_remote_directory}</span></p>}
          {(h.observed_os ?? h.declared_os) === 'macos' && <SigningSettings h={h} act={act} busy={busy} />}
        </div>
        <div>
          <h3>Capabilities</h3>
          <p className="muted small">Declared is a claim. Observed comes from a probe at a point in time.</p>
          <table className="inline-table"><thead><tr><th>Key</th><th>Declared</th><th>Observed</th></tr></thead><tbody>
            {h.capabilities.map((c: any) => <tr key={c.key} onContextMenu={(e) => openMenu(e, [{ label: 'Probe again', icon: '⟳', disabled: busy, onClick: () => act(async () => setLastCheck(await call('probeCapabilities', { host_id: id, probe_ids: [c.key] }))) }, '-', copyItem('Copy key', c.key), copyItem('Copy result', c.observation?.details)], c.key)}><td className="mono">{c.key}</td><td>{c.label || c.declared_description || '✓'} <span className="muted">({c.declaration_source})</span></td>
              <td>{c.observation ? <><span className={`badge cap-${c.observation.state}`}>{c.observation.state}</span> {age(c.observed_at)}<div className="muted small pre">{c.observation.details}</div></> : <span className="muted">not probed</span>}</td></tr>)}
          </tbody></table>
          <div className="row"><input className="mono grow" value={probes} onChange={(e) => setProbes(e.target.value)} title="comma separated: macos.xcode, binary:git" />
            <button disabled={busy} onClick={() => act(async () => setLastCheck(await call('probeCapabilities', { host_id: id, probe_ids: probes.split(',').map((s) => s.trim()).filter(Boolean) })))}>Probe</button></div>
          {lastCheck?.observations && <pre className="small">{JSON.stringify(lastCheck.observations, null, 1)}</pre>}
          <h3>Child Resources</h3>
          {h.resources.length === 0 ? <p className="muted">None (e.g. an iPhone attached to this Mac). Agents can add them via ssh_hosts_update.</p>
            : <ul>{h.resources.map((r: any) => <li key={r.id}>{r.label} <span className="muted">({r.resource_kind})</span></li>)}</ul>}
          <h3>History</h3>
          <table className="inline-table small"><thead><tr><th>When</th><th>Kind</th><th>Outcome</th><th>ms</th></tr></thead><tbody>
            {(hist.data?.checks ?? []).map((c: any) => <tr key={c.id} title={c.diagnostics?.stderr ?? ''} onContextMenu={(e) => openMenu(e, [copyItem('Copy error output', c.diagnostics?.stderr), copyItem('Copy error code', c.error_code), copyItem('Copy time', new Date(c.started_at).toLocaleString())])}><td>{age(c.started_at)}</td><td>{c.kind}</td>
              <td>{c.outcome ?? 'running'} {c.error_code}{c.identity_generation !== h.identity_generation ? ' (old settings)' : ''}</td><td>{c.duration_ms}</td></tr>)}
          </tbody></table>
        </div>
      </div>
      <HostProjects host={h} />
      {menuNode}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════
// Projects on host
// ═══════════════════════════════════════════════════════════

/** Browses folders on the remote host over SSH (read-only). Never a local file dialog for remote paths. */
function RemoteFolderPicker({ hostId, start, onPick, onClose }: { hostId: string; start: string; onPick: (p: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(start || '~');
  const [typed, setTyped] = useState(start || '~');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true); setErr(null);
    call('listRemoteDir', { host_id: hostId, path }).then((r) => { setRes(r); if (r.path) setTyped(r.path); }).catch((e) => setErr(errText(e))).finally(() => setLoading(false));
  }, [hostId, path]);
  const join = (base: string, name: string) => (base.endsWith('/') ? base + name : `${base}/${name}`);
  const [menuNode, openMenu] = useMenu();
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row"><b>Choose a folder on the host</b><span className="grow" /><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="row">
          <button disabled={!res?.parent} onClick={() => setPath(res.parent)}>↑ Up</button>
          <button onClick={() => setPath('~')}>~ Home</button>
          <input className="grow mono" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setPath(typed)} />
          <button onClick={() => setPath(typed)}>Go</button>
        </div>
        <Err e={err} />
        {res?.error && <div className="error">{res.error === 'missing' ? 'Folder does not exist.' : res.error === 'not_permitted' ? 'Permission denied.' : 'Folder is not accessible.'} {res.hint}</div>}
        <div className="picker-list">
          {loading && <p className="muted">Loading…</p>}
          {!loading && res?.entries?.length === 0 && !res.error && <p className="muted">No sub-folders.</p>}
          {!loading && res?.entries?.map((e: any) => (
            <div key={e.name} className={`picker-item ${e.name.startsWith('.') ? 'dim' : ''}`} onDoubleClick={() => setPath(join(res.path, e.name))} onClick={() => setTyped(join(res.path, e.name))}
              onContextMenu={(ev) => { const p = join(res.path, e.name); setTyped(p); openMenu(ev, [{ label: 'Open', icon: '📂', onClick: () => setPath(p) }, { label: 'Use this folder', icon: '✓', onClick: () => onPick(p) }, '-', copyItem('Copy path', p)], e.name); }}>
              📁 {e.name} {e.git && <span className="badge st-reachable">git</span>} {e.project_marker && <span className="badge">project</span>}
            </div>
          ))}
        </div>
        <div className="row">
          <span className="muted small grow">Double-click to open · click to select · right-click for more</span>
          <button className="primary" disabled={!typed || !!res?.error && typed === res?.path} onClick={() => onPick(typed)}>Use "{typed.length > 40 ? '…' + typed.slice(-40) : typed}"</button>
        </div>
        {menuNode}
      </div>
    </div>
  );
}

function PathField({ value, onChange, hostId, placeholder }: { value: string; onChange: (v: string) => void; hostId: string | null; placeholder: string }) {
  const [browsing, setBrowsing] = useState(false);
  return (
    <div className="row nowrap">
      <input className="grow mono" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      <button onClick={async () => {
        if (hostId) setBrowsing(true);
        else { const p = await window.api.pickFolder(); if (p) onChange(p); }
      }}>Browse…</button>
      {browsing && hostId && <RemoteFolderPicker hostId={hostId} start={value || '~'} onClose={() => setBrowsing(false)} onPick={(p) => { onChange(p); setBrowsing(false); }} />}
    </div>
  );
}

/** Asks the manager to search the host for an existing copy (by project/folder/package name + Git identity). */
function FindOnHost({ hostId, query, onPick }: { hostId: string; query: { project_id?: string; source_path?: string; name?: string }; onPick: (p: string) => void }) {
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const can = !!(query.project_id || query.source_path || query.name);
  const search = async () => { setBusy(true); setErr(null); try { setRes(await call('findProjectOnHost', { host_id: hostId, ...query })); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };
  return (
    <div className="find">
      <button disabled={!can || busy} onClick={search} title={can ? '' : 'Enter a project name or source folder first'}>{busy ? 'Searching host…' : '🔎 Find existing copy on host'}</button>
      <Err e={err} />
      {res && (
        <div className="find-results">
          <div className="muted small">Searched {res.search_root} (depth {res.max_depth}) for {res.searched_for.folder_names.join(', ')}{res.searched_for.package_names.length ? ` · package ${res.searched_for.package_names.join(', ')}` : ''}</div>
          {res.candidates.length === 0 && <div className="small">No existing copy found.</div>}
          {res.candidates.map((c: any) => (
            <div key={c.path} className="row candidate">
              <span className="mono grow">{c.path}</span>
              {c.same_repository === true && <span className="badge st-reachable">same git repo</span>}
              {c.same_repository === false && <span className="badge st-error">different repo</span>}
              {c.same_repository === null && <span className="badge">{c.git ? 'git, identity unknown' : 'no git'}</span>}
              <span className="muted small">{c.matched_by.join(' + ').replaceAll('_', ' ')}{c.modified ? ` · ${c.modified}` : ''}</span>
              {c.bound_location_id ? <span className="badge">already mapped</span>
                : <button disabled={c.same_repository === false} onClick={() => onPick(c.path)}>Use</button>}
            </div>
          ))}
          {res.note && <div className="warn small">{res.note}</div>}
        </div>
      )}
    </div>
  );
}

function HostProjects({ host }: { host: any }) {
  const { data, error, reload } = usePoll(() => call('listProjects', {}), [], 3000);
  const [adding, setAdding] = useState(false);
  const projects: any[] = data?.projects ?? [];
  const mapped = projects.filter((p) => p.locations.some((l: any) => l.host_id === host.id));
  return (
    <section className="host-projects">
      <div className="row"><h3>Projects on this host</h3><span className="grow" /><button className="primary" onClick={() => setAdding(true)}>+ Add project mapping</button></div>
      <p className="muted small">Each mapping links a project folder on this PC (source of truth) to a folder on {host.name}. Saving a mapping never clones, creates or copies anything.</p>
      <Err e={error} />
      {adding && <NewMapping host={host} projects={projects} onDone={() => { setAdding(false); reload(); }} />}
      {data && mapped.length === 0 && !adding && <p className="muted">No projects mapped to this host yet.</p>}
      {mapped.map((p) => p.locations.filter((l: any) => l.host_id === host.id).map((dest: any) => (
        <MappingCard key={dest.id} project={p} source={p.locations.find((l: any) => l.id === dest.source_location_id)} dest={dest} host={host} reload={reload} />
      )))}
    </section>
  );
}

function NewMapping({ host, projects, onDone }: { host: any; projects: any[]; onDone: () => void }) {
  const [projectId, setProjectId] = useState<string>('new');
  const [name, setName] = useState('');
  const [src, setSrc] = useState('');
  const [dst, setDst] = useState('');
  const [mode, setMode] = useState('adopt_existing');
  const [setup, setSetup] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef({ p: idem(), l: idem() });
  const existing = projects.find((p) => p.id === projectId);
  const primary = existing?.locations.find((l: any) => l.id === existing.source_location_id)?.path_input ?? '';
  const otherSource = !!existing && !!src && src !== primary;
  async function save() {
    setBusy(true); setErr(null);
    try {
      let project = existing;
      if (!project) {
        project = (await call('registerProject', { name: name.trim(), source_location: { host_id: null, path: src || null, label: 'PC' }, idempotency_key: keys.current.p })).project;
      }
      await call('bindProjectLocation', { project_id: project.id, host_id: host.id, path: dst || null, mode, label: setup.trim() || host.name, expected_project_revision: project.revision,
        idempotency_key: keys.current.l, ...(otherSource ? { source_path: src } : {}) });
      onDone();
    } catch (e) { setErr(errText(e)); keys.current = { p: idem(), l: idem() }; } finally { setBusy(false); }
  }
  return (
    <fieldset>
      <legend>New mapping</legend>
      <Err e={err} />
      <L t="Project">
        <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setSrc(''); }}>
          <option value="new">➕ New project…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </L>
      {!existing && <L t="Project name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Quran Coach" /></L>}
      <L t="Source folder on this PC">
        <PathField value={existing ? src || primary : src} onChange={setSrc} hostId={null} placeholder="C:\src\my-app" />
        {otherSource && <div className="warn small">A different copy of this project: it becomes an independent working setup with its own destination folder. The existing source ({primary || 'unset'}) is not changed. If that copy only moved, edit its path on the existing mapping instead.</div>}
      </L>
      <L t="Setup name (optional)"><input value={setup} onChange={(e) => setSetup(e.target.value)} placeholder={otherSource ? 'e.g. learning-branch experiment' : host.name} /></L>
      <L t={`Destination folder on ${host.name} (optional; can be set later)`}><PathField value={dst} onChange={setDst} hostId={host.id} placeholder="~/dev/my-app" /></L>
      <FindOnHost hostId={host.id} query={existing ? { project_id: existing.id } : { source_path: src || undefined, name: name.trim() || undefined }} onPick={setDst} />
      <div className="row">
        <label><input type="radio" checked={mode === 'adopt_existing'} onChange={() => setMode('adopt_existing')} /> Use an existing folder (inspect before use)</label>
        <label><input type="radio" checked={mode === 'create_if_missing'} onChange={() => setMode('create_if_missing')} /> Folder may not exist yet (agent creates it as a planned step)</label>
      </div>
      <div className="row"><button className="primary" disabled={busy || (!existing && (!name.trim() || !src))} onClick={save}>Save mapping</button><button onClick={onDone}>Cancel</button></div>
    </fieldset>
  );
}

function MappingCard({ project, source, dest, host, reload }: { project: any; source: any; dest: any; host: any; reload: () => void }) {
  const [edit, setEdit] = useState<{ which: 'src' | 'dst'; value: string } | null>(null);
  const [pre, setPre] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [synced, setSynced] = useState<string | null>(null);
  const run = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); setErr(null); setSynced(null); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(null); reload(); } };
  const exec = pre?.suggested_plan.exec;
  const [menuNode, openMenu] = useMenu();
  const preflight = () => run('pre', async () => setPre(await call('preflightProject', { project_id: project.id, destination_location_id: dest.id, intent: 'build' })));
  const syncNow = () => run('sync', async () => { const r = await call('syncProject', { project_id: project.id, destination_location_id: dest.id }); setPre(null); setSynced(r.note); });
  const srcDir = source?.canonical_path ?? source?.path_input, dstDir = dest.canonical_path ?? dest.path_input;
  const menu = (e: React.MouseEvent) => openMenu(e, [
    { label: 'Preflight', icon: '⟳', disabled: !!busy, onClick: preflight },
    exec && { label: 'Sync now', icon: '⇡', disabled: !!busy, onClick: syncNow },
    { label: 'Open in Projects view', icon: '▣', onClick: () => openInProjects(project.id, dest.id) },
    '-',
    ...localFileItems(srcDir, true),
    dstDir && { label: `Open folder on ${host.name}`, icon: '🖥', onClick: () => run('open', async () => setSynced(await openOnHost(host.id, dstDir))) },
    '-',
    copyItem('Copy source path', srcDir), copyItem(`Copy path on ${host.name}`, dstDir),
    '-',
    { label: 'Change source path…', icon: '✏️', onClick: () => setEdit({ which: 'src', value: source?.path_input ?? '' }) },
    { label: 'Change destination path…', icon: '✏️', onClick: () => setEdit({ which: 'dst', value: dest.path_input ?? '' }) },
    '-',
    { label: 'Remove mapping…', icon: '🗑', danger: true, onClick: () => run('rm', () => removeMapping(project, dest, host.name)) },
  ], `${project.name} → ${host.name}`);
  const syncLabel = exec && [{ git_clone: 'clone', git_switch: 'switch branch', git_fast_forward: 'fast-forward' }[pre.suggested_plan.kind as string],
    exec.copy.length ? `${exec.copy.length} file${exec.copy.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ');
  const gitLine = (l: any) => l?.last_inspection ? `${l.last_inspection.branch ?? (l.last_inspection.detached ? 'detached' : 'no git')}${l.last_inspection.head ? ' ' + l.last_inspection.head.slice(0, 8) : ''}${l.last_inspection.dirty && (l.last_inspection.dirty.staged + l.last_inspection.dirty.unstaged + l.last_inspection.dirty.untracked) ? ` · ${l.last_inspection.dirty.staged + l.last_inspection.dirty.unstaged + l.last_inspection.dirty.untracked} uncommitted` : ''} · ${age(l.last_inspection.at)}` : 'not inspected';
  const side = (which: 'src' | 'dst', l: any, title: string, hostId: string | null) => (
    <div className="side">
      <div className="muted small">{title}</div>
      {edit?.which === which ? (
        <>
          <PathField value={edit.value} onChange={(v) => setEdit({ which, value: v })} hostId={hostId} placeholder={hostId ? '~/dev/app' : 'C:\\src\\app'} />
          {hostId && <FindOnHost hostId={hostId} query={{ project_id: project.id }} onPick={(p) => setEdit({ which, value: p })} />}
          <div className="warn small">Old: {l?.path_input ?? '(unset)'} → New: {edit.value || '(unset)'}. Files are not moved; verification resets.</div>
          <div className="row">
            <button className="primary" onClick={() => run('edit', async () => { await call('updateProjectLocation', { location_id: l.id, expected_revision: l.revision, patch: { path: edit.value || null }, idempotency_key: idem() }); setEdit(null); setPre(null); })}>Save path</button>
            <button onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <div className="mono">{l?.path_input ?? <span className="muted">unset</span>} <span className={`badge ps-${l?.path_state}`}>{l?.path_state}</span>
            <button className="link" onClick={() => setEdit({ which, value: l?.path_input ?? '' })}>Change</button></div>
          {l?.canonical_path && l.canonical_path !== l.path_input && <div className="muted small mono">→ {l.canonical_path}</div>}
          <div className="small">{gitLine(l)}</div>
        </>
      )}
    </div>
  );
  return (
    <div className="mapping" onContextMenu={menu}>
      <div className="row">
        <b>{project.name}</b>
        {dest.label && dest.label !== host.name && <span className="badge" title="working setup">{dest.label}</span>}
        <span className={`badge id-${dest.identity_state}`} title="identity of the destination folder">{dest.identity_state.replace('_', ' ')}</span>
        <span className="small muted">{dest.last_verified_sync ? `synced & verified ${age(dest.last_verified_sync.verified_at)}` : 'never verified'}{dest.last_sync_attempt && !dest.last_verified_sync ? ` · last attempt ${dest.last_sync_attempt.outcome}` : ''}</span>
        <span className="grow" />
        <button disabled={!!busy} onClick={preflight}>{busy === 'pre' ? 'Checking…' : 'Preflight'}</button>
        {exec && <button className="primary" disabled={!!busy} title="Runs the plan below over SSH (fast-forward only, never overwrites destination work), then verifies" onClick={syncNow}>
          {busy === 'sync' ? 'Syncing…' : `Sync now${syncLabel ? ` (${syncLabel})` : ''}`}</button>}
        <button className="danger" onClick={() => run('rm', () => removeMapping(project, dest, host.name))}>Remove</button>
        <button className="ghost" onClick={menu} title="More actions">⋯</button>
      </div>
      <Err e={err} />
      {synced && <div className="small">✓ {synced}</div>}
      <div className="sides">
        {side('src', source, 'Source · this PC', null)}
        <div className="arrow">→</div>
        {side('dst', dest, `Destination · ${host.name}`, host.id)}
      </div>
      {dest.identity_state === 'mismatch' && <div className="error">This folder's Git history does not match the project. <button onClick={() => { if (confirm('Confirm this folder belongs to the project (e.g. a fork)?')) run('confirm', () => call('updateProjectLocation', { location_id: dest.id, expected_revision: dest.revision, patch: { confirm_identity: true }, idempotency_key: idem() })); }}>It is the same project</button></div>}
      {pre && (
        <div className="preflight">
          <div className="row"><span className={`badge v-${pre.verdict}`}>{pre.verdict.replaceAll('_', ' ')}</span><span className="muted small">{age(pre.evaluated_at)} · source snapshot {pre.source_snapshot}</span><span className="grow" /><button className="link" onClick={() => setPre(null)}>hide</button></div>
          <div className="row small">{Object.entries(pre.summary.readiness).map(([k, v]) => <span key={k} className="badge" title={k === 'toolchain' ? pre.toolchain?.note ?? '' : ''}>{k.replace('_', ' ')}: {String(v).replaceAll('_', ' ')}</span>)}</div>
          <ul>{pre.facts.map((f: any, i: number) => <li key={i} className={f.blocking ? '' : 'muted'}><b>{f.kind.replaceAll('_', ' ')}</b>: {f.detail}{f.paths?.length ? <div className="mono small">{f.paths.slice(0, 12).join('  ')}{f.paths.length > 12 ? ' …' : ''}</div> : null}</li>)}</ul>
          <div className="small"><b>Plan ({pre.suggested_plan.kind.replaceAll('_', ' ')})</b> <span className="muted">— {exec ? 'Sync now runs it here, or' : ''} carried out by your AI agent through SSH, then verified here</span></div>
          <ol className="small">{pre.suggested_plan.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
        </div>
      )}
      {menuNode}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Setup Tab
// ═══════════════════════════════════════════════════════════



const AGENT_ICON: Record<string, [string, string]> = {
  'claude-desktop': ['🟠', 'claude'], 'claude-code': ['🟠', 'claude'], codex: ['🟢', 'codex'], gemini: ['🔵', 'antigravity'],
  antigravity: ['🔵', 'antigravity'], cursor: ['⚫', ''], vscode: ['🟦', ''], windsurf: ['🌊', ''],
};

function QuickBindSection({ mcpConfigJson }: { mcpConfigJson: string }) {
  const [list, setList] = useState<AgentStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [menuNode, openMenu] = useMenu();
  const load = () => window.api.mcpAgents().then(setList).catch((e) => setNote({ ok: false, text: errText(e) }));
  useEffect(() => { load(); }, []);

  const set = async (targets: AgentStatus[], add: boolean) => {
    setBusy(targets.length > 1 ? 'all' : targets[0].id); setNote(null);
    const done: string[] = [], failed: string[] = [];
    for (const t of targets) {
      const r = await window.api.mcpAgentSet(t.id, add);
      if (r.ok) done.push(`${t.name}: ${t.restart}`); else failed.push(`${t.name}: ${r.error.message}`);
    }
    setNote(failed.length ? { ok: false, text: failed.join('\n') } : { ok: true, text: add ? `Added. To load it: ${done.join(' ')}` : 'Removed.' });
    setBusy(null); load();
  };
  const doCopy = async () => { await copy(mcpConfigJson); setNote({ ok: true, text: "MCP config copied. Paste it under the agent's MCP servers." }); };

  const found = list?.filter((a) => a.detected || a.state !== 'missing') ?? [];
  const others = list?.filter((a) => !found.includes(a)) ?? [];
  const pending = found.filter((a) => a.state === 'missing' || a.state === 'other_build');

  const restore = async (a: AgentStatus) => {
    if (!(await window.api.agentBackupExists(a.id))) return setNote({ ok: false, text: `No backup of ${a.name}'s config yet (one is made on the first Add, Update or Remove).` });
    if (!confirm(`Put back ${a.name}'s config as it was before the last change made here?

${a.file}`)) return;
    const r = await window.api.restoreAgentBackup(a.id);
    setNote(r.ok ? { ok: true, text: `Restored. ${a.restart}` } : { ok: false, text: r.error.message }); load();
  };
  const cardMenu = (e: React.MouseEvent, a: AgentStatus) => {
    const exists = a.state !== 'missing' || a.detected;
    openMenu(e, [
      a.state === 'missing' && { label: 'Add', icon: '➕', disabled: !!busy, onClick: () => set([a], true) },
      a.state === 'other_build' && { label: 'Update to this app', icon: '↻', disabled: !!busy, onClick: () => set([a], true) },
      (a.state === 'current' || a.state === 'other_build') && { label: 'Remove', icon: '➖', disabled: !!busy, onClick: () => set([a], false) },
      '-',
      exists && { label: 'Open config file', icon: '📄', onClick: () => window.api.openFile(a.file).then((r) => r !== true && setNote({ ok: false, text: r === 'missing' ? 'The config file does not exist yet: Add creates it.' : r })) },
      exists && { label: 'Show in Explorer', icon: '📂', onClick: () => window.api.revealFile(a.file).then((ok) => !ok && setNote({ ok: false, text: 'The config file does not exist yet: Add creates it.' })) },
      copyItem('Copy config file path', a.file),
      copyItem('Copy MCP entry JSON', mcpConfigJson),
      '-',
      { label: 'Restore previous file…', icon: '↶', onClick: () => restore(a) },
    ], a.name);
  };

  const card = (a: AgentStatus) => {
    const [icon, cls] = AGENT_ICON[a.id] ?? ['🤖', ''];
    return (
      <div key={a.id} className="bind-card" onContextMenu={(e) => cardMenu(e, a)}>
        <button className="ghost bind-card-more" onClick={(e) => cardMenu(e, a)} title="More actions">⋯</button>
        <div className="bind-card-header">
          <div className={`bind-card-icon ${cls}`}>{icon}</div>
          <div className="bind-card-info">
            <div className="bind-name">{a.name}</div>
            <div className="bind-desc">{{ current: '✓ Connected to this app', other_build: '⚠ Points at another copy of this app', missing: a.detected ? 'Not added yet' : 'Not found on this PC', unreadable: '⚠ Config could not be read' }[a.state]}</div>
          </div>
        </div>
        <div className="muted small mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.file}</div>
        {a.error && <div className="warn small">{a.error}</div>}
        <div className="bind-card-actions">
          {a.state === 'missing' && <button className="primary" disabled={!!busy} onClick={() => set([a], true)}>{busy === a.id ? 'Adding…' : '➕ Add'}</button>}
          {a.state === 'other_build' && <button className="primary" disabled={!!busy} onClick={() => set([a], true)}>{busy === a.id ? 'Updating…' : '↻ Update to this app'}</button>}
          {(a.state === 'current' || a.state === 'other_build') && <button disabled={!!busy} onClick={() => set([a], false)}>Remove</button>}
          {a.state === 'unreadable' && <button onClick={doCopy}>📋 Copy MCP config</button>}
        </div>
      </div>
    );
  };

  return (
    <fieldset>
      <legend>Connect AI agents</legend>
      <p className="muted small" style={{ marginBottom: 12 }}>
        One click adds this SSH manager as an MCP server to an AI agent. Only its own entry is written, everything else in the file stays; the previous file is kept as <span className="mono">*.sshrm.bak</span>.
      </p>
      {pending.length > 1 && <button className="primary" style={{ marginBottom: 12 }} disabled={!!busy} onClick={() => set(pending, true)}>{busy === 'all' ? 'Adding…' : `➕ Add to all ${pending.length} agents found`}</button>}
      {note && <div className={note.ok ? 'success' : 'error'} style={{ whiteSpace: 'pre-line' }}>{note.ok ? '✓ ' : ''}{note.text}</div>}
      {!list ? <p className="muted">Looking for AI agents…</p> : (
        <>
          {found.length === 0 && <p className="muted small">No supported AI agent found on this PC. Use "Copy MCP config" below.</p>}
          <div className="quick-bind-grid">{found.map(card)}</div>
          {others.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted small" style={{ cursor: 'pointer' }}>Other agents ({others.map((a) => a.name).join(', ')})</summary>
              <div className="quick-bind-grid" style={{ marginTop: 8 }}>{others.map(card)}</div>
            </details>
          )}
        </>
      )}
      <details style={{ marginTop: 8 }}>
        <summary className="muted small" style={{ cursor: 'pointer' }}>Another agent? Copy the MCP configuration JSON</summary>
        <button style={{ marginTop: 8 }} onClick={doCopy}>📋 Copy MCP config</button>
        <pre style={{ marginTop: 8 }}>{mcpConfigJson}</pre>
      </details>
      {menuNode}
    </fieldset>
  );
}

function StartupSettings() {
  const [li, setLi] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  useEffect(() => { window.api.loginItem().then(setLi); }, []);
  return (
    <fieldset><legend>Startup & Tray</legend>
      <p className="muted small">Closing the window keeps the app in the tray. AI agents also start it in the tray when they connect. To exit completely, right-click the tray icon → Quit.</p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" disabled={!li?.supported} checked={!!li?.enabled} onChange={async (e) => setLi(await window.api.setLoginItem(e.target.checked))} />
        Start with Windows (in the tray, no window)
      </label>
      {li && !li.supported && <div className="muted small">Available in the installed app only.</div>}
    </fieldset>
  );
}

function Setup() {
  const [s, setS] = useState<any>(null);
  const [env, setEnv] = useState<any>(null);
  const [cfg, setCfg] = useState<string>('');
  const [msg, setMsg] = useState<string | null>(null);
  const [imp, setImp] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      call('getSettings').then(setS).catch((e) => setLoadError(errText(e))),
      call('environment').then(setEnv).catch((e) => setLoadError(errText(e))),
      window.api.mcpConfig().then((c) => setCfg(JSON.stringify(c, null, 2))).catch((e) => setLoadError(errText(e))),
    ]);
  }, []);

  if (loadError) return (
    <section>
      <div className="page-header"><h2>Setup</h2></div>
      <div className="error">{loadError}</div>
    </section>
  );
  if (!s || !env) return (
    <section>
      <div className="page-header"><h2>Setup</h2></div>
      <p className="muted">Loading configuration…</p>
    </section>
  );

  const save = async (patch: object) => { try { setS(await call('setSettings', patch)); setMsg('Saved'); setTimeout(() => setMsg(null), 2000); } catch (e) { setMsg(errText(e)); } };

  return (
    <section>
      <div className="page-header">
        <h2>Setup</h2>
      </div>
      {msg && <div className="note">{msg}</div>}

      {/* Quick Bind Section */}
      <QuickBindSection mcpConfigJson={cfg} />

      {/* Environment */}
      <fieldset><legend>Environment</legend>
        <div className="setup-grid">
          <div>
            <p><span className="muted small">Execution environment</span><br /><b>{env.execution_environment}</b></p>
            <p className="muted small" style={{ marginTop: 4 }}>Agents must call from the same environment (e.g. PowerShell on Windows, not WSL).</p>
          </div>
          <div>
            <p><span className="muted small">Data directory</span><br /><span className="mono">{env.data_dir}</span></p>
            <button style={{ marginTop: 6 }} onClick={() => window.api.openDataDir()}>Open Data Dir</button>
          </div>
          <div>
            <p><span className="muted small">App known_hosts</span><br /><span className="mono">{env.known_hosts}</span></p>
          </div>
        </div>
      </fieldset>

      {/* OpenSSH */}
      <fieldset><legend>OpenSSH & Tooling</legend>
        <div className="grid">
          {(['ssh_path', 'scp_path', 'sftp_path', 'ssh_keygen_path', 'git_path'] as const).map((k) => (
            <L key={k} t={k}><input className="mono" defaultValue={s[k]} onBlur={(e) => e.target.value !== s[k] && save({ [k]: e.target.value })} /></L>
          ))}
        </div>
        <h3>Timeouts</h3>
        <div className="grid">
          {(['connect_timeout_s', 'check_timeout_s', 'probe_timeout_s', 'stale_after_seconds'] as const).map((k) => (
            <L key={k} t={k.replaceAll('_', ' ')}><input defaultValue={s[k]} inputMode="numeric" onBlur={(e) => Number(e.target.value) !== s[k] && save({ [k]: Number(e.target.value) })} /></L>
          ))}
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <input type="checkbox" checked={s.gui_auto_check} onChange={(e) => save({ gui_auto_check: e.target.checked })} />
          Auto-check stale enabled hosts every 60s while the GUI is open
        </label>
      </fieldset>

      {/* Startup */}
      <StartupSettings />

      {/* Export / Import */}
      <fieldset><legend>Data Management</legend>
        <p className="muted small" style={{ marginBottom: 10 }}>Export, import, or back up your SSH host registry data.</p>
        <div className="row">
          <button onClick={async () => { const p = await window.api.exportData(); if (p) setMsg(`Exported to ${p} (no keys, trust approvals or diagnostics)`); }}>Export metadata…</button>
          <button onClick={async () => { const r = await window.api.importPreview(); if (r) setImp(r); }}>Import…</button>
          <button onClick={async () => { const p = await window.api.backup(); if (p) setMsg(`Consistent DB backup written to ${p}`); }}>Backup database…</button>
        </div>
        {imp && (imp.ok ? (
          <div className="preview">
            <p>{imp.result.note}</p>
            <ul>{imp.result.hosts.map((h: any, i: number) => <li key={i}>{h.name} <span className="mono">{h.target}</span> {h.duplicates.length ? <span className="badge warn">possible duplicate</span> : null}</li>)}</ul>
            <p>{imp.result.projects.length} project(s); local paths will need review.</p>
            <div className="row">
              <button className="primary" onClick={async () => { const r = await window.api.importApply(); setMsg(r.ok ? JSON.stringify(r.result) : errText(new CallError(r.error))); setImp(null); }}>Import as new records</button>
              <button onClick={() => setImp(null)}>Cancel</button>
            </div>
          </div>
        ) : <div className="error">{imp.error.message}</div>)}
      </fieldset>

      <p className="muted small" style={{ marginTop: 16 }}>
        Test MCP: ask your agent to call <span className="mono">ssh_manager_environment</span>, then <span className="mono">ssh_hosts_list</span>.
        MCP gives the agent registry tools only; it still needs its own terminal to run ssh.
        See docs/AGENT_INSTRUCTIONS.md.
      </p>
    </section>
  );
}
