// Narrow, typed bridge. The renderer never sees ipcRenderer or Node.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('api', {
  call: (method: string, arg?: unknown) => ipcRenderer.invoke('core', method, arg),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  loginItem: () => ipcRenderer.invoke('login-item'),
  setLoginItem: (enabled: boolean) => ipcRenderer.invoke('set-login-item', enabled),
  importP12: (hostId: string, password: string) => ipcRenderer.invoke('import-p12', hostId, password),
  mcpConfig: () => ipcRenderer.invoke('mcp-config'),
  mcpAgents: () => ipcRenderer.invoke('mcp-agents'),
  mcpAgentSet: (id: string, add: boolean) => ipcRenderer.invoke('mcp-agent-set', id, add),
  exportData: () => ipcRenderer.invoke('export'),
  importPreview: () => ipcRenderer.invoke('import-preview'),
  importApply: () => ipcRenderer.invoke('import-apply'),
  backup: () => ipcRenderer.invoke('backup'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  showFolder: (path: string) => ipcRenderer.invoke('show-folder', path),
  openInVscode: (path: string, sshAlias?: string) => ipcRenderer.invoke('open-in-vscode', path, sshAlias),
  copyText: (text: string) => ipcRenderer.invoke('copy-text', text),
  revealFile: (path: string) => ipcRenderer.invoke('reveal-file', path),
  openFile: (path: string) => ipcRenderer.invoke('open-file', path),
  openWith: (path: string) => ipcRenderer.invoke('open-with', path),
  openIgnoreFile: (dir: string) => ipcRenderer.invoke('open-ignore-file', dir),
  restoreAgentBackup: (id: string) => ipcRenderer.invoke('restore-agent-backup', id),
  agentBackupExists: (id: string) => ipcRenderer.invoke('agent-backup-exists', id),
});
