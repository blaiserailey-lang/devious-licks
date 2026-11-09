const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('library', {
  get: () => ipcRenderer.invoke('library:get'),
  refresh: () => ipcRenderer.invoke('library:refresh'),
  play: (id) => ipcRenderer.invoke('game:play', id),
  onProgress: (fn) => ipcRenderer.on('library:progress', (_e, p) => fn(p)),
});
