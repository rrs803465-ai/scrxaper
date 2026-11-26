const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ScrxDesktop', { setUrl: (u) => ipcRenderer.invoke('scrx:set-url', u), info: () => ipcRenderer.invoke('scrx:info') });
