const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { Library, githubSource, folderSource } = require('./catalog');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

// app://app/...    -> files bundled with the app (UI, EmulatorJS, cores)
// app://rom/<file> -> a downloaded ROM from the library cache
// app://cover/<f>  -> a downloaded cover image
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let library;
let libraryWindow;
const playerWindows = new Map();

function makeSource() {
  if (process.env.DL_CATALOG_DIR) return folderSource(process.env.DL_CATALOG_DIR);
  return githubSource({ ...pkg.deviousLicks.catalog, token: process.env.DL_GITHUB_TOKEN });
}

function inside(base, target) {
  const rel = path.relative(base, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function serveFile(file) {
  return net.fetch(pathToFileURL(file).toString());
}

function registerProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (url.host === 'app') {
      const file = path.join(ROOT, rel);
      if (!inside(ROOT, file)) return new Response('Forbidden', { status: 403 });
      return serveFile(file);
    }
    if (url.host === 'rom') {
      const game = library.state.games.find((g) => g.romFile === rel);
      if (!game) return new Response('Not found', { status: 404 });
      return serveFile(library.romPath(game));
    }
    if (url.host === 'cover') {
      const file = path.join(library.dir, 'covers', rel);
      if (!inside(path.join(library.dir, 'covers'), file)) return new Response('Forbidden', { status: 403 });
      return serveFile(file);
    }
    return new Response('Not found', { status: 404 });
  });
}

function createLibraryWindow() {
  libraryWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    title: 'Devious Licks',
    backgroundColor: '#0d0b12',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  libraryWindow.loadURL('app://app/src/renderer/index.html');
  libraryWindow.on('closed', () => (libraryWindow = null));
  libraryWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function openGame(id) {
  const game = library.find(id);
  if (!game) return;
  const existing = playerWindows.get(id);
  if (existing && !existing.isDestroyed()) return existing.focus();
  const win = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 480,
    minHeight: 400,
    title: game.title,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const q = new URLSearchParams({
    id: game.id,
    romUrl: `app://rom/${encodeURIComponent(game.romFile)}`,
    core: game.core,
    title: game.title,
    // Save files are tied to this id; it changes only if the ROM changes.
    saveId: `${game.id}-${(game.sha256 || '').slice(0, 10)}`,
  });
  win.loadURL(`app://app/src/renderer/player.html?${q}`);
  win.setMenuBarVisibility(false);
  playerWindows.set(id, win);
  win.on('closed', () => playerWindows.delete(id));
}

let refreshing = null;
function refresh() {
  if (!refreshing) {
    const send = (p) => libraryWindow && libraryWindow.webContents.send('library:progress', p);
    refreshing = library
      .refresh(send)
      .catch((err) => ({ ...library.view(), error: friendlyError(err) }))
      .finally(() => (refreshing = null));
  }
  return refreshing;
}

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(msg)) return "Can't reach GitHub. You can still play the games you already have.";
  if (/HTTP 404/.test(msg)) return "Couldn't find the game catalog on GitHub. Check that the repo is public.";
  return msg;
}

app.whenReady().then(async () => {
  library = new Library(path.join(app.getPath('userData'), 'library'), makeSource());
  await library.load();
  registerProtocol();

  ipcMain.handle('library:get', () => library.view());
  ipcMain.handle('library:refresh', () => refresh());
  ipcMain.handle('game:play', (_e, id) => openGame(id));

  createLibraryWindow();
  app.on('activate', () => {
    if (!libraryWindow) createLibraryWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
