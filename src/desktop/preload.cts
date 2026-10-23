// Narrow, typed bridge. The renderer never sees ipcRenderer or Node.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('api', {
  call: (method: string, arg?: unknown) => ipcRenderer.invoke('core', method, arg),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  mcpConfig: () => ipcRenderer.invoke('mcp-config'),
  exportData: () => ipcRenderer.invoke('export'),
  importPreview: () => ipcRenderer.invoke('import-preview'),
  importApply: () => ipcRenderer.invoke('import-apply'),
  backup: () => ipcRenderer.invoke('backup'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
});
