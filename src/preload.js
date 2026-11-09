const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('library', {
  get: () => ipcRenderer.invoke('library:get'),
  refresh: () => ipcRenderer.invoke('library:refresh'),
  play: (id, opts) => ipcRenderer.invoke('game:play', id, opts),
  addLocal: (files) => ipcRenderer.invoke('local:add', files ? [...files].map((f) => webUtils.getPathForFile(f)) : []),
  removeLocal: (id) => ipcRenderer.invoke('local:remove', id),
  onProgress: (fn) => ipcRenderer.on('library:progress', (_e, p) => fn(p)),
});
