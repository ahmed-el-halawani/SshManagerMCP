import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { age, call, CallError, errText, idem } from './api.ts';

type Status = { state: string; checked_at: string | null; stale: boolean; error_code: string | null };
type HostSummary = { id: string; name: string; enabled: boolean; target: string; declared_os: string; observed_os: string | null; os_mismatch: boolean; tags: string[]; revision: number; status: Status; capability_keys: string[] };

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

const Badge = ({ s }: { s: Status }) => (
  <span className={`badge st-${s.state}`} title={s.error_code ?? ''}>
    {s.state.replace('_', ' ')}{s.checked_at ? ` · ${age(s.checked_at)}` : ''}{s.stale && s.checked_at ? ' · stale' : ''}
  </span>
);

const Err = ({ e }: { e: string | null }) => (e ? <div className="error">{e}</div> : null);
const copy = (t: string) => navigator.clipboard.writeText(t);

export function App() {
  const [tab, setTab] = useState<'hosts' | 'setup'>('hosts');
  const [hostId, setHostId] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | string | null>(null);
  return (
    <div className="app">
      <nav>
        <b>SSH Resource Manager</b>
        {(['hosts', 'setup'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); setHostId(null); setEditing(null); }}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </nav>
      <main>
        {tab === 'hosts' && editing && <HostForm hostId={editing === 'new' ? null : editing} onDone={(id) => { setEditing(null); if (id) setHostId(id); }} />}
        {tab === 'hosts' && !editing && hostId && <HostDetail id={hostId} onBack={() => setHostId(null)} onEdit={() => setEditing(hostId)} />}
        {tab === 'hosts' && !editing && !hostId && <HostList onOpen={setHostId} onAdd={() => setEditing('new')} />}
        {tab === 'setup' && <Setup />}
      </main>
    </div>
  );
}

// ---------------- hosts ----------------

function HostList({ onOpen, onAdd }: { onOpen: (id: string) => void; onAdd: () => void }) {
  const [query, setQuery] = useState('');
  const { data, error } = usePoll(() => call<{ hosts: HostSummary[] }>('listHosts', { query: query || undefined, limit: 100 }), [query]);
  const settings = usePoll(() => call<{ gui_auto_check: boolean }>('getSettings'), [], 10_000).data;
  const running = useRef(new Set<string>());
  useEffect(() => {
    if (!settings?.gui_auto_check || !data) return;
    const t = setInterval(() => {
      for (const h of data.hosts.filter((x) => x.enabled && x.status.stale && x.status.state !== 'checking')) {
        if (running.current.size >= 2 || running.current.has(h.id)) continue;
        running.current.add(h.id);
        setTimeout(() => call('checkHost', { host_id: h.id }).catch(() => {}).finally(() => running.current.delete(h.id)), Math.random() * 5000);
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [settings?.gui_auto_check, data]);
  return (
    <section>
      <div className="row">
        <h2>Hosts</h2>
        <input placeholder="Search name, target, description" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="primary" onClick={onAdd}>Add host</button>
      </div>
      <Err e={error} />
      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.hosts.length === 0 && <p className="muted">No hosts yet. Add one here, or ask your AI agent to register it through MCP.</p>}
      {data && data.hosts.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>OS (declared / observed)</th><th>Target</th><th>Status</th><th>Capabilities</th></tr></thead>
          <tbody>
            {data.hosts.map((h) => (
              <tr key={h.id} onClick={() => onOpen(h.id)} className={`click ${h.enabled ? '' : 'dim'}`}>
                <td>{h.name}<div className="id">{h.id.slice(0, 8)}</div></td>
                <td>{h.declared_os} / {h.observed_os ?? '—'} {h.os_mismatch && <span className="badge warn">mismatch</span>}</td>
                <td className="mono">{h.target}</td>
                <td><Badge s={h.status} /></td>
                <td>{h.capability_keys.slice(0, 4).join(', ')}{h.capability_keys.length > 4 ? ` +${h.capability_keys.length - 4}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

type FormState = {
  mode: 'direct' | 'ssh_alias'; auth: 'key' | 'password'; password: string; hostname: string; port: string; username: string; identity_file: string; identities_only: boolean; proxy_jump: string;
  alias: string; config_path: string; name: string; declared_os: string; description: string; instructions: string; tags: string; default_remote_directory: string; caps: string; enabled: boolean;
};
const emptyForm: FormState = { mode: 'direct', auth: 'key', password: '', hostname: '', port: '22', username: '', identity_file: '', identities_only: false, proxy_jump: '', alias: '', config_path: '',
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
    setF({ ...emptyForm, mode: p.mode, auth: p.auth ?? 'key', hostname: p.hostname ?? '', port: String(p.port ?? 22), username: p.username ?? '', identity_file: p.identity_file ?? '',
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
      if (andCheck) await call('checkHost', { host_id: id }).catch(() => {});
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
      <div className="row"><h2>{hostId ? 'Edit host' : 'Add host'}</h2><button onClick={() => onDone(hostId)}>Cancel</button></div>
      {conflict && <div className="error">This host was changed elsewhere (GUI or agent). Your edits were not saved. <button onClick={() => load()}>Reload latest</button></div>}
      <Err e={err} />
      {!hostId && (
        <fieldset>
          <legend>Import from an ssh command (no network, nothing is executed)</legend>
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
        <label><input type="radio" checked={f.mode === 'direct'} onChange={() => setF({ ...f, mode: 'direct' })} /> Direct</label>
        <label><input type="radio" checked={f.mode === 'ssh_alias'} onChange={() => setF({ ...f, mode: 'ssh_alias' })} /> Existing ssh_config alias</label>
        {f.mode === 'direct' ? (
          <div className="grid">
            <L t="Hostname / IP"><input value={f.hostname} onChange={set('hostname')} /></L>
            <L t="Port"><input value={f.port} onChange={set('port')} inputMode="numeric" /></L>
            <L t="Username"><input value={f.username} onChange={set('username')} /></L>
            <L t="Identity file (local path reference, optional)"><input value={f.identity_file} onChange={set('identity_file')} /></L>
            <L t="ProxyJump aliases (comma separated)"><input value={f.proxy_jump} onChange={set('proxy_jump')} /></L>
            <L t="ssh config path (optional)"><input value={f.config_path} onChange={set('config_path')} /></L>
            <label><input type="checkbox" checked={f.identities_only} onChange={set('identities_only')} /> IdentitiesOnly</label>
          </div>
        ) : (
          <div className="grid">
            <L t="Alias (literal Host from your ssh config)"><input value={f.alias} onChange={set('alias')} /></L>
            <L t="ssh config path (optional)"><input value={f.config_path} onChange={set('config_path')} /></L>
            <p className="muted">Aliases use your own ssh_config and known_hosts. This app never edits them.</p>
          </div>
        )}
        <div className="row">
          <span>Authentication:</span>
          <label><input type="radio" checked={f.auth === 'key'} onChange={() => setF({ ...f, auth: 'key' })} /> SSH key / ssh-agent</label>
          <label><input type="radio" checked={f.auth === 'password'} onChange={() => setF({ ...f, auth: 'password' })} /> Username + password</label>
        </div>
        {f.auth === 'password' ? (
          <div className="grid">
            <L t={stored ? 'Password (stored — leave empty to keep it)' : 'Password'}>
              <input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} placeholder={stored ? '••••••••' : ''} />
            </L>
            <p className="muted">Encrypted with Windows DPAPI for your Windows account. It is never shown again, never sent to AI agents, and is deleted automatically if the host address/user changes.
              {stored && hostId && <> <button onClick={async () => { await call('clearHostPassword', { host_id: hostId }); setStored(false); }}>Forget stored password</button></>}</p>
          </div>
        ) : <p className="muted">Uses keys loaded in ssh-agent or the identity file above. Private keys and passphrases are never stored.</p>}
      </fieldset>
      <fieldset>
        <legend>Description</legend>
        <div className="grid">
          <L t="Display name"><input value={f.name} onChange={set('name')} /></L>
          <L t="Declared OS"><select value={f.declared_os} onChange={set('declared_os')}>{['unknown', 'macos', 'linux', 'windows'].map((o) => <option key={o}>{o}</option>)}</select></L>
          <L t="Tags (comma separated)"><input value={f.tags} onChange={set('tags')} /></L>
          <L t="Default remote directory (suggestion only)"><input value={f.default_remote_directory} onChange={set('default_remote_directory')} /></L>
          <label><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> Enabled</label>
        </div>
        <L t="Description"><textarea value={f.description} onChange={set('description')} rows={2} /></L>
        <L t="Instructions for agents"><textarea value={f.instructions} onChange={set('instructions')} rows={3} /></L>
        <L t="Declared capabilities — one per line: key | label (e.g. macos.xcode | Xcode 16)"><textarea className="mono" value={f.caps} onChange={set('caps')} rows={3} /></L>
      </fieldset>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => save(false)}>Save</button>
        <button disabled={busy} onClick={() => save(true)}>Save and check</button>
      </div>
    </section>
  );
}
const L = ({ t, children }: { t: string; children: ReactNode }) => <label className="field"><span>{t}</span>{children}</label>;

function HostDetail({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: () => void }) {
  const { data: h, error, reload } = usePoll(() => call('getHost', { host_id: id }), [id]);
  const hist = usePoll(() => call('hostHistory', { host_id: id, limit: 15 }), [id], 5000);
  const [msg, setMsg] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<any>(null);
  const [probes, setProbes] = useState('binary:git');
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg(errText(e)); } finally { setBusy(false); reload(); hist.reload(); } };
  if (error) return <section><button onClick={onBack}>← Back</button><Err e={error} /></section>;
  if (!h) return <p className="muted">Loading…</p>;
  const env = navigator.userAgent.includes('Windows') ? 'windows-native' : 'posix-native';
  return (
    <section>
      <div className="row"><button onClick={onBack}>← Hosts</button><h2>{h.name}</h2><Badge s={h.status} /></div>
      <div className="id">ID {h.id} · revision {h.revision} · identity generation {h.identity_generation}</div>
      <Err e={msg} />
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => act(async () => setLastCheck(await call('checkHost', { host_id: id })))}>Check now</button>
        <button onClick={() => act(async () => { const r = await call('connectionRecipe', { host_id: id, caller_environment: env }); await copy(r.display); setMsg('SSH command copied to clipboard'); })}>Copy SSH command</button>
        <button onClick={() => act(async () => { const r = await call('connectionRecipe', { host_id: id, caller_environment: env, purpose: 'file_transfer' }); await copy(r.display); setMsg('scp template copied'); })}>Copy scp template</button>
        <button onClick={onEdit}>Edit</button>
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
          {' '}<button disabled={busy} onClick={() => act(async () => setLastCheck(await call('checkHost', { host_id: id })))}>Show fingerprint to verify</button>
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
          <p>Authentication: <b>{h.auth === 'password' ? 'username + password' : 'SSH key / agent'}</b>{h.auth === 'password' && (h.password_stored ? ' · password stored (encrypted)' : <span className="warn"> · no password stored — Edit to set it</span>)}</p>
          <p>Trusted keys: {h.trust.length ? h.trust.map((t: any) => `${t.algorithm} ${t.fingerprint} (${age(t.approved_at)})`).join('; ') : h.profile.mode === 'ssh_alias' ? 'user-managed known_hosts' : 'none'}</p>
          <h3>Description</h3><p className="pre">{h.description || <span className="muted">—</span>}</p>
          <h3>Instructions</h3><p className="pre">{h.instructions || <span className="muted">—</span>}</p>
          {h.default_remote_directory && <p>Default remote directory: <span className="mono">{h.default_remote_directory}</span></p>}
        </div>
        <div>
          <h3>Capabilities</h3>
          <p className="muted">Declared is a claim. Observed comes from a probe at a point in time.</p>
          <table><thead><tr><th>Key</th><th>Declared</th><th>Observed</th></tr></thead><tbody>
            {h.capabilities.map((c: any) => <tr key={c.key}><td className="mono">{c.key}</td><td>{c.label || c.declared_description || '✓'} <span className="muted">({c.declaration_source})</span></td>
              <td>{c.observation ? <><span className={`badge cap-${c.observation.state}`}>{c.observation.state}</span> {age(c.observed_at)}<div className="muted small pre">{c.observation.details}</div></> : <span className="muted">not probed</span>}</td></tr>)}
          </tbody></table>
          <div className="row"><input className="mono grow" value={probes} onChange={(e) => setProbes(e.target.value)} title="comma separated: macos.xcode, binary:git" />
            <button disabled={busy} onClick={() => act(async () => setLastCheck(await call('probeCapabilities', { host_id: id, probe_ids: probes.split(',').map((s) => s.trim()).filter(Boolean) })))}>Probe</button></div>
          {lastCheck?.observations && <pre className="small">{JSON.stringify(lastCheck.observations, null, 1)}</pre>}
          <h3>Child resources</h3>
          {h.resources.length === 0 ? <p className="muted">None (e.g. an iPhone attached to this Mac). Agents can add them via ssh_hosts_update.</p>
            : <ul>{h.resources.map((r: any) => <li key={r.id}>{r.label} <span className="muted">({r.resource_kind})</span></li>)}</ul>}
          <h3>History</h3>
          <table className="small"><thead><tr><th>When</th><th>Kind</th><th>Outcome</th><th>ms</th></tr></thead><tbody>
            {(hist.data?.checks ?? []).map((c: any) => <tr key={c.id} title={c.diagnostics?.stderr ?? ''}><td>{age(c.started_at)}</td><td>{c.kind}</td>
              <td>{c.outcome ?? 'running'} {c.error_code}{c.identity_generation !== h.identity_generation ? ' (old settings)' : ''}</td><td>{c.duration_ms}</td></tr>)}
          </tbody></table>
        </div>
      </div>
      <HostProjects host={h} />
    </section>
  );
}

// ---------------- projects (per host: PC source folder → folder on this host) ----------------

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
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row"><b>Choose a folder on the host</b><span className="grow" /><button onClick={onClose}>✕</button></div>
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
            <div key={e.name} className={`picker-item ${e.name.startsWith('.') ? 'dim' : ''}`} onDoubleClick={() => setPath(join(res.path, e.name))} onClick={() => setTyped(join(res.path, e.name))}>
              📁 {e.name} {e.git && <span className="badge st-reachable">git</span>} {e.project_marker && <span className="badge">project</span>}
            </div>
          ))}
        </div>
        <div className="row">
          <span className="muted small grow">Double-click to open · click to select</span>
          <button className="primary" disabled={!typed || !!res?.error && typed === res?.path} onClick={() => onPick(typed)}>Use “{typed.length > 40 ? '…' + typed.slice(-40) : typed}”</button>
        </div>
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
  const run = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); setErr(null); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(null); reload(); } };
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
    <div className="mapping">
      <div className="row">
        <b>{project.name}</b>
        {dest.label && dest.label !== host.name && <span className="badge" title="working setup">{dest.label}</span>}
        <span className={`badge id-${dest.identity_state}`} title="identity of the destination folder">{dest.identity_state.replace('_', ' ')}</span>
        <span className="small muted">{dest.last_verified_sync ? `synced & verified ${age(dest.last_verified_sync.verified_at)}` : 'never verified'}{dest.last_sync_attempt && !dest.last_verified_sync ? ` · last attempt ${dest.last_sync_attempt.outcome}` : ''}</span>
        <span className="grow" />
        <button disabled={!!busy} onClick={() => run('pre', async () => setPre(await call('preflightProject', { project_id: project.id, destination_location_id: dest.id, intent: 'build' })))}>{busy === 'pre' ? 'Checking…' : 'Preflight'}</button>
        <button className="danger" onClick={() => {
          const onlyHost = project.locations.filter((l: any) => l.role !== 'source').length === 1;
          if (!confirm(`Remove the mapping of "${project.name}" to ${host.name}?\n\nMetadata only: no folder on either machine is touched.${onlyHost ? '\nThe project itself is removed too (it has no other hosts).' : ''}`)) return;
          run('rm', async () => {
            await call('unbindProjectLocation', { location_id: dest.id, expected_revision: dest.revision });
            if (onlyHost) { const p = await call('getProject', { project_id: project.id }); await call('removeProject', { project_id: project.id, expected_revision: p.revision }); }
          });
        }}>Remove</button>
      </div>
      <Err e={err} />
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
          <div className="small"><b>Plan ({pre.suggested_plan.kind.replaceAll('_', ' ')})</b> <span className="muted">— carried out by your AI agent through SSH, then verified here</span></div>
          <ol className="small">{pre.suggested_plan.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
        </div>
      )}
    </div>
  );
}

// ---------------- setup ----------------

function Setup() {
  const [s, setS] = useState<any>(null);
  const [env, setEnv] = useState<any>(null);
  const [cfg, setCfg] = useState<string>('');
  const [msg, setMsg] = useState<string | null>(null);
  const [imp, setImp] = useState<any>(null);
  useEffect(() => {
    call('getSettings').then(setS); call('environment').then(setEnv);
    window.api.mcpConfig().then((c) => setCfg(JSON.stringify(c, null, 2)));
  }, []);
  if (!s || !env) return <p className="muted">Loading…</p>;
  const save = async (patch: object) => { try { setS(await call('setSettings', patch)); setMsg('Saved'); } catch (e) { setMsg(errText(e)); } };
  return (
    <section>
      <h2>Setup</h2>
      {msg && <div className="note">{msg}</div>}
      <fieldset><legend>Environment</legend>
        <p>Execution environment: <b>{env.execution_environment}</b>. Agents must call from the same environment (e.g. PowerShell on Windows, not WSL).</p>
        <p>Data directory: <span className="mono">{env.data_dir}</span> <button onClick={() => window.api.openDataDir()}>Open</button></p>
        <p>App known_hosts: <span className="mono">{env.known_hosts}</span></p>
      </fieldset>
      <fieldset><legend>OpenSSH</legend>
        <div className="grid">
          {(['ssh_path', 'scp_path', 'sftp_path', 'ssh_keygen_path', 'git_path'] as const).map((k) => (
            <L key={k} t={k}><input className="mono" defaultValue={s[k]} onBlur={(e) => e.target.value !== s[k] && save({ [k]: e.target.value })} /></L>
          ))}
          {(['connect_timeout_s', 'check_timeout_s', 'probe_timeout_s', 'stale_after_seconds'] as const).map((k) => (
            <L key={k} t={k}><input defaultValue={s[k]} inputMode="numeric" onBlur={(e) => Number(e.target.value) !== s[k] && save({ [k]: Number(e.target.value) })} /></L>
          ))}
          <label><input type="checkbox" checked={s.gui_auto_check} onChange={(e) => save({ gui_auto_check: e.target.checked })} /> Auto-check stale enabled hosts every 60 s while the GUI is open</label>
        </div>
      </fieldset>
      <fieldset><legend>MCP client configuration</legend>
        <p>Add this to your AI client's MCP config (e.g. Claude Desktop / Claude Code). This app never edits client configs.</p>
        <pre>{cfg}</pre>
        <button onClick={() => copy(cfg)}>Copy</button>
        <p className="muted">Test: ask your agent to call <span className="mono">ssh_manager_environment</span>, then <span className="mono">ssh_hosts_list</span>. MCP gives the agent registry tools only; it still needs its own terminal to run ssh. See docs/AGENT_INSTRUCTIONS.md.</p>
      </fieldset>
      <fieldset><legend>Export / import / backup</legend>
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
            <button className="primary" onClick={async () => { const r = await window.api.importApply(); setMsg(r.ok ? JSON.stringify(r.result) : errText(new CallError(r.error))); setImp(null); }}>Import as new records</button>
            <button onClick={() => setImp(null)}>Cancel</button>
          </div>
        ) : <div className="error">{imp.error.message}</div>)}
      </fieldset>
    </section>
  );
}
