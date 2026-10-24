// Narrow, typed bridge. The renderer never sees ipcRenderer or Node.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('api', {
  call: (method: string, arg?: unknown) => ipcRenderer.invoke('core', method, arg),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  loginItem: () => ipcRenderer.invoke('login-item'),
  setLoginItem: (enabled: boolean) => ipcRenderer.invoke('set-login-item', enabled),
  importP12: (hostId: string, password: string) => ipcRenderer.invoke('import-p12', hostId, password),
  mcpConfig: () => ipcRenderer.invoke('mcp-config'),
  exportData: () => ipcRenderer.invoke('export'),
  importPreview: () => ipcRenderer.invoke('import-preview'),
  importApply: () => ipcRenderer.invoke('import-apply'),
  backup: () => ipcRenderer.invoke('backup'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
});
