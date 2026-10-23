import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore, createLogger, errorPayload } from '../core/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const core = createCore({ source: 'gui' });
const log = createLogger(core.dataDir, 'gui');

// Only these core methods are reachable from the renderer. No shell/exec channel exists.
const ALLOWED = new Set(['parseConnectionInput', 'registerHost', 'updateHost', 'listHosts', 'getHost', 'removeHost', 'checkHost', 'probeCapabilities',
  'approveHostKey', 'connectionRecipe', 'setHostPassword', 'clearHostPassword', 'listRemoteDir', 'hostHistory', 'registerProject', 'listProjects', 'getProject', 'removeProject', 'bindProjectLocation',
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, title: 'SSH Resource Manager',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.removeMenu();
  win.loadFile(join(here, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => cb({
    responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'"] },
  }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  createWindow();
});
app.on('window-all-closed', () => { core.close(); app.quit(); });
