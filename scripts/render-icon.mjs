// Renders assets/icon.svg to assets/icon.png (512px) with Electron itself, so no image library is needed.
// usage: npx electron scripts/render-icon.mjs
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'assets', 'icon.svg'), 'utf8');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,<html><body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body></html>`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  writeFileSync(join(root, 'assets', 'icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  console.log('wrote assets/icon.png', img.getSize());
  app.quit();
});
