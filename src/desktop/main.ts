import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore, createLogger, errorPayload } from '../core/index.ts';

// One app per user. A second launch (agent self-open, login item, double-click) only wakes the first one.
// --background = start in the tray without a window (login item, MCP self-open).
const BACKGROUND = '--background';
if (!app.requestSingleInstanceLock()) process.exit(0); // sync: nothing below may run (it would open the DB)

const here = dirname(fileURLToPath(import.meta.url));
const ICON = join(here, '..', '..', 'assets', 'icon.png'); // source: assets/icon.svg, rendered by scripts/render-icon.mjs
const core = createCore({ source: 'gui' });
const log = createLogger(core.dataDir, 'gui');

// Only these core methods are reachable from the renderer. No shell/exec channel exists.
const ALLOWED = new Set(['parseConnectionInput', 'registerHost', 'updateHost', 'listHosts', 'getHost', 'removeHost', 'checkHost', 'probeCapabilities',
  'approveHostKey', 'connectionRecipe', 'setHostPassword', 'clearHostPassword', 'switchToKeyAuth','setSigningMode', 'setupBuildKeychain', 'listRemoteDir', 'hostHistory', 'registerProject', 'listProjects', 'getProject', 'removeProject', 'bindProjectLocation',
  'updateProjectLocation', 'unbindProjectLocation', 'inspectProject', 'findProjectOnHost', 'preflightProject', 'getSettings', 'setSettings', 'environment']);

ipcMain.handle('core', async (_e, method: string, arg: unknown) => {
  if (!ALLOWED.has(method)) return { ok: false, error: { code: 'VALIDATION_ERROR', message: `unknown method ${method}` } };
  try {
    return { ok: true, result: await (core as unknown as Record<string, (a: unknown) => unknown>)[method](arg) };
  } catch (e) {
    const error = errorPayload(e);
    log('warn', method, { code: error.code });
    return { ok: false, error };
  }
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// One-time .p12 for the build keychain: the file is read here and goes straight to the Mac over SSH stdin.
ipcMain.handle('import-p12', async (_e, hostId: string, password: string) => {
  const r = await dialog.showOpenDialog({ title: 'Signing certificate exported from Keychain Access', filters: [{ name: 'PKCS#12', extensions: ['p12', 'pfx'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  try {
    return { ok: true, result: await core.setupBuildKeychain({ host_id: hostId, p12: { base64: readFileSync(r.filePaths[0]).toString('base64'), password } }) };
  } catch (e) { return { ok: false, error: errorPayload(e) }; }
});

ipcMain.handle('mcp-config', () => {
  // Same executable runs the MCP server as plain Node: one runtime, no global Node needed.
  // Data dir is pinned explicitly so a client can never silently open a different DB.
  const entry = join(here, '..', 'mcp', 'server.js');
  return { mcpServers: { 'ssh-resource-manager': { command: process.execPath, args: [entry, `--data-dir=${core.dataDir}`], env: { ELECTRON_RUN_AS_NODE: '1' } } } };
});

ipcMain.handle('export', async () => {
  const r = await dialog.showSaveDialog({ defaultPath: 'ssh-resource-manager-export.json' });
  if (r.canceled || !r.filePath) return null;
  writeFileSync(r.filePath, JSON.stringify(core.exportData(), null, 2));
  return r.filePath;
});

let pendingImport: unknown = null;
ipcMain.handle('import-preview', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled) return null;
  try {
    pendingImport = JSON.parse(readFileSync(r.filePaths[0], 'utf8'));
    return { ok: true, result: core.previewImport(pendingImport) };
  } catch (e) { return { ok: false, error: errorPayload(e) }; }
});
ipcMain.handle('import-apply', () => {
  try { return { ok: true, result: core.applyImport(pendingImport, `import-${Date.now()}`) }; } catch (e) { return { ok: false, error: errorPayload(e) }; }
});

ipcMain.handle('backup', async () => {
  const r = await dialog.showSaveDialog({ defaultPath: `registry-backup-${new Date().toISOString().slice(0, 10)}.db` });
  if (r.canceled || !r.filePath) return null;
  return core.backup(r.filePath).backup;
});

ipcMain.handle('open-data-dir', () => shell.openPath(core.dataDir));

ipcMain.handle('copy-text', (_e, text: string) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

// ---- start with Windows: the OS login item is the source of truth; packaged builds only (dev would register electron.exe)
const loginItem = () => ({ supported: app.isPackaged, enabled: app.isPackaged && app.getLoginItemSettings({ args: [BACKGROUND] }).openAtLogin });
// The user's choice is kept in the data dir and re-applied on every start, so the entry follows the exe that
// actually runs (e.g. moving from the unpacked build to the installed app). Default: on.
const LOGIN_CHOICE = join(core.dataDir, 'start-with-windows');
function setLoginItem(enabled: boolean) {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, args: [BACKGROUND] });
  writeFileSync(LOGIN_CHOICE, enabled ? 'on' : 'off');
  refreshTray();
  return loginItem();
}
ipcMain.handle('login-item', () => loginItem());
ipcMain.handle('set-login-item', (_e, enabled: boolean) => setLoginItem(!!enabled));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function showWindow() {
  if (!win) createWindow();
  if (win!.isMinimized()) win!.restore();
  win!.show();
  win!.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, title: 'SSH Resource Manager', show: false, icon: ICON,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.removeMenu();
  win.loadFile(join(here, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win?.show());
  // Closing the window keeps the app in the tray; only "Quit" in the tray menu exits.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win!.hide();
    const flag = join(core.dataDir, 'tray-hint-shown');
    if (!existsSync(flag)) {
      tray?.displayBalloon({ title: 'SSH Resource Manager is still running', content: 'It stays in the tray so AI agents can use it. Right-click the tray icon → Quit to exit.' });
      writeFileSync(flag, '');
    }
  });
}

function refreshTray() {
  if (!tray) return;
  const li = loginItem();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open SSH Resource Manager', click: showWindow },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: li.enabled, enabled: li.supported, click: (m) => setLoginItem(m.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

app.on('second-instance', (_e, argv) => { if (!argv.includes(BACKGROUND)) showWindow(); });
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('will-quit', () => core.close());

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => cb({
    responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'"] },
  }));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    if (permission === 'clipboard-sanitized-write' || permission === 'clipboard-read') {
      return cb(true);
    }
    cb(false);
  });
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' }));
  tray.setToolTip('SSH Resource Manager');
  tray.on('click', showWindow);
  if (app.isPackaged) setLoginItem(!existsSync(LOGIN_CHOICE) || readFileSync(LOGIN_CHOICE, 'utf8').trim() !== 'off');
  refreshTray();
  if (!process.argv.includes(BACKGROUND)) showWindow();
});
