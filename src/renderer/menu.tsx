// One right-click menu for every view. Usage:
//   const [menu, openMenu] = useMenu();
//   <div onContextMenu={(e) => openMenu(e, [{ label: 'Copy', onClick: ... }, '-', ...], 'header')}>  ...  {menu}
// Falsy entries are skipped, so items can be written as `cond && { ... }`. A click on a "⋯" button opens the same menu.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { copy } from './api.ts';

export type MenuItem = { label: ReactNode; icon?: string; onClick: () => unknown; disabled?: boolean; danger?: boolean; title?: string } | '-' | null | undefined | false | '';
type Open = { x: number; y: number; items: Exclude<MenuItem, null | undefined | false | ''>[]; header?: ReactNode };

export function useMenu(): [ReactNode, (e: MouseEvent, items: MenuItem[], header?: ReactNode) => void] {
  const [m, setM] = useState<Open | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const open = (e: MouseEvent, items: MenuItem[], header?: ReactNode) => {
    // text boxes keep the app-wide Cut/Copy/Paste menu (main process)
    if (e.type === 'contextmenu' && (e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault(); e.stopPropagation();
    const sel = window.getSelection()?.toString().trim();
    const list = [...(sel ? [copyItem('Copy', sel), '-' as const] : []), ...items].filter(Boolean) as Open['items'];
    // no separators at the ends or twice in a row
    const clean = list.filter((it, i) => it !== '-' || (i > 0 && i < list.length - 1 && list[i - 1] !== '-'));
    if (clean.length) setM({ x: e.clientX, y: e.clientY, items: clean, header });
  };

  // keep the whole menu inside the window
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !m) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(m.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(m.y, window.innerHeight - r.height - 4))}px`;
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [m]);

  useEffect(() => {
    if (!m) return;
    const close = () => setM(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const bs = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const i = bs.indexOf(document.activeElement as HTMLButtonElement);
      bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]?.focus();
    };
    // next tick: the click/contextmenu that opened the menu must not close it
    const t = setTimeout(() => { window.addEventListener('click', close); window.addEventListener('contextmenu', close); });
    window.addEventListener('keydown', key); window.addEventListener('blur', close); window.addEventListener('resize', close); window.addEventListener('scroll', close, true);
    return () => { clearTimeout(t); window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); window.removeEventListener('keydown', key); window.removeEventListener('blur', close); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [m]);

  const node = m && (
    <div ref={ref} className="context-menu" role="menu" style={{ left: m.x, top: m.y }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {m.header && <div className="context-menu-header mono small ellipsis">{m.header}</div>}
      {m.items.map((it, i) => it === '-' ? <div key={i} className="context-menu-sep" /> : (
        <button key={i} role="menuitem" className={`context-menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled} title={it.title}
          onClick={() => { setM(null); it.onClick(); }}>
          <span className="menu-icon">{it.icon ?? ''}</span><span>{it.label}</span>
        </button>
      ))}
    </div>
  );
  return [node, open];
}

/** "Copy …" item. */
export const copyItem = (label: string, text: string | null | undefined, icon = '📋'): MenuItem => !!text && { label, icon, onClick: () => copy(text) };

/** Windows path of a project file: the source folder + the slash-separated path the check reports. */
export const localPath = (dir: string | null | undefined, rel: string) => dir ? `${dir.replace(/[\\/]+$/, '')}\\${rel.replaceAll('/', '\\')}` : null;
export const hostPath = (dir: string | null | undefined, rel: string) => dir ? `${dir.replace(/\/+$/, '')}/${rel}` : null;

/** Open / Open with / VS Code / Explorer for a file on this PC. */
export function localFileItems(path: string | null, folder = false): MenuItem[] {
  if (!path) return [];
  return folder
    ? [{ label: 'Show in Explorer', icon: '📂', onClick: () => window.api.showFolder(path) }, { label: 'Open in VS Code', icon: '⌨', onClick: () => window.api.openInVscode(path) }]
    : [{ label: 'Open', icon: '📄', onClick: () => window.api.openFile(path) }, { label: 'Open with…', icon: '🗂', onClick: () => window.api.openWith(path) },
      { label: 'Open in VS Code', icon: '⌨', onClick: () => window.api.openInVscode(path) }, { label: 'Show in Explorer', icon: '📂', onClick: () => window.api.revealFile(path) }];
}
