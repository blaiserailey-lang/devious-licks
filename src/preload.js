const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('library', {
  get: () => ipcRenderer.invoke('library:get'),
  refresh: () => ipcRenderer.invoke('library:refresh'),
  play: (id, opts) => ipcRenderer.invoke('game:play', id, opts),
  // (A list of dropped files: an array arrives as one; anything list-like arrives as a plain object.)
  addLocal: (files) =>
    ipcRenderer.invoke(
      'local:add',
      (Array.isArray(files) ? files : Object.values(files || {})).map((f) => {
        try {
          return webUtils.getPathForFile(f);
        } catch {
          return '';
        }
      })
    ),
  removeLocal: (id) => ipcRenderer.invoke('local:remove', id),
  // A picture for a game added from a file: the dropped file, or (without one) the app asks which.
  setCover: (id, file) => {
    let from = '';
    try {
      from = file ? webUtils.getPathForFile(file) : '';
    } catch {
      from = '';
    }
    return ipcRenderer.invoke('local:cover', id, file ? from || null : ''); // null: something was dropped that is not a file on this Mac
  },
  onProgress: (fn) => ipcRenderer.on('library:progress', (_e, p) => fn(p)),
  // "This window has drawn its page and is talking to the app." An update
  // has to get this far before it counts as working (see main.js).
  up: () => ipcRenderer.send('app:up'),
  // The Update button. Every call answers with the update's state (see view() in updater.js):
  // { phase, version, installed, latest, percent, notes, why, error, ... }
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    restart: () => ipcRenderer.invoke('update:restart'),
    openPage: () => ipcRenderer.invoke('update:page'),
    onState: (fn) => ipcRenderer.on('update:state', (_e, s) => fn(s)),
  },
});
