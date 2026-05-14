const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launch: () => ipcRenderer.invoke('launch-game'),
  install: () => ipcRenderer.invoke('install-game'),
  getStatus: () => ipcRenderer.invoke('get-game-status'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  authLogin: () => ipcRenderer.invoke('auth-login'),
  authLogout: (uuid) => ipcRenderer.invoke('auth-logout', uuid),
  authRemove: (uuid) => ipcRenderer.invoke('auth-remove', uuid),
  authSetActive: (uuid) => ipcRenderer.invoke('auth-set-active', uuid),
  onGameStatus: (callback) => {
    ipcRenderer.on('game-status', (_, status) => callback(status));
  },
});
