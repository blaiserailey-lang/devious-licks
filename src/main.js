const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Library, githubSource, folderSource } = require('./catalog');
const { LocalGames, EXTENSIONS } = require('./local');
const n64 = require('./n64');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

// "--smoke-test" (the release workflow runs the packaged app with it): start
// as usual, check that the library window came up with its bridge to this
// process and that the built-in N64 player is where the app looks for it,
// print the verdict and quit. It keeps its files out of the real library.
const SMOKE = process.argv.includes('--smoke-test');
if (SMOKE) app.setPath('userData', path.join(app.getPath('temp'), `devious-licks-smoke-${process.pid}`));

// app://app/...    -> files bundled with the app (UI, EmulatorJS, cores)
// app://rom/<file> -> a downloaded ROM from the library cache
// app://local/<file> -> a game added from a file on this Mac
// app://cover/<f>  -> a downloaded cover image
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let library;
let local;
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
    if (url.host === 'local') {
      const game = local.games.find((g) => g.romFile === rel);
      if (!game) return new Response('Not found', { status: 404 });
      return serveFile(local.romPath(game));
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

// Emulator settings for one game: what the launcher knows this title needs
// (see n64.js), then anything set for it in games.json under "options".
async function emulatorOptions(game, romPath) {
  const known = N64_CORES.has(game.core) ? n64.optionsFor(await n64.readHeader(romPath)) : {};
  return { ...known, ...n64.cleanOptions(game.options) };
}

const opening = new Set(); // game ids being started right now (a double-click must not start two)

async function openGame(id, opts) {
  if (opening.has(id)) return;
  opening.add(id);
  try {
    await startGame(id, opts);
  } finally {
    opening.delete(id);
  }
}

async function startGame(id, { reset = false, diagnose = false } = {}) {
  const localGame = local.find(id);
  const game = localGame || library.find(id);
  if (!game) return;
  const romPath = localGame ? local.romPath(game) : library.romPath(game);
  const options = await emulatorOptions(game, romPath);
  const native = !reset && nativeCoreFor(game);
  if (native) {
    openNative(game, romPath, native, options, diagnose);
    return;
  }
  const existing = playerWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    if (!reset) return existing.focus();
    existing.destroy();
  }
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
    romUrl: `app://${localGame ? 'local' : 'rom'}/${encodeURIComponent(game.romFile)}`,
    core: game.core,
    title: game.title,
    // Save files are tied to this id; it changes only if the ROM changes.
    saveId: `${game.id}-${(game.sha256 || '').slice(0, 10)}`,
  });
  if (Object.keys(options).length) q.set('options', JSON.stringify(options));
  if (reset) q.set('reset', '1');
  win.loadURL(`app://app/src/renderer/player.html?${q}`);
  win.setMenuBarVisibility(false);
  playerWindows.set(id, win);
  win.on('closed', () => playerWindows.delete(id));
}

function view(base = library.view()) {
  const games = [...local.view(), ...base.games];
  return { ...base, games };
}

async function addLocal(files) {
  if (!files || !files.length) {
    const pick = await dialog.showOpenDialog(libraryWindow, {
      title: 'Add a game from your Mac',
      buttonLabel: 'Add to Library',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Game ROMs', extensions: EXTENSIONS }],
    });
    if (pick.canceled) return { ...view(), added: [], skipped: [] };
    files = pick.filePaths;
  }
  const result = await local.add(files);
  return { ...view(), ...result };
}

// N64 is too heavy for the built-in (WebAssembly) emulator, so N64 games run in
// the bundled native Devious Licks Player (player/dl-player.c + a native
// Mupen64Plus core). Option-click still forces the built-in emulator.
const N64_CORES = new Set(['n64', 'mupen64plus_next']);
const NATIVE_CORES = { n64: 'mupen64plus_next_libretro.dylib', mupen64plus_next: 'mupen64plus_next_libretro.dylib' };
const PLAYER_DIR = app.isPackaged ? path.join(process.resourcesPath, 'player') : path.join(ROOT, 'player', 'dist');
const PLAYER_ICON = app.isPackaged ? path.join(process.resourcesPath, 'icon.icns') : path.join(ROOT, 'build', 'icon.png');
const nativePlayers = new Map();

function nativeCoreFor(game) {
  const dylib = NATIVE_CORES[game.core];
  if (!dylib || process.platform !== 'darwin') return null;
  const core = path.join(PLAYER_DIR, dylib);
  const bin = path.join(PLAYER_DIR, 'dl-player');
  return fs.existsSync(core) && fs.existsSync(bin) ? { core, bin } : null;
}

function tail(file, lines) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function openNative(game, romPath, native, options, diagnose) {
  const running = nativePlayers.get(game.id);
  if (running) {
    running.kill('SIGURG'); // already open: ask it to come to the front (harmless if it isn't listening yet)
    return;
  }
  const data = app.getPath('userData');
  const logFile = path.join(data, 'logs', `player-${game.core}.log`);
  const args = [
    '--core', native.core,
    '--rom', romPath,
    '--title', game.title,
    '--save-dir', path.join(data, 'saves', game.core),
    '--system-dir', path.join(data, 'system'),
    '--no-dialog',
  ];
  if (fs.existsSync(PLAYER_ICON)) args.push('--icon', PLAYER_ICON);
  for (const [key, value] of Object.entries(options)) args.push('--option', `${key}=${value}`);
  // Shift-click: the player also writes the emulator's graphics calls into
  // the log (the first frames, every error, and one more frame per F8 press).
  if (diagnose) args.push('--gl-trace', '3', '--gl-probe');

  // Everything the player and the emulator core print goes to a log file, so
  // there is something to look at when a game misbehaves.
  let log = 'ignore';
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    log = fs.openSync(logFile, 'w');
    fs.writeSync(log, `Devious Licks ${app.getVersion()} on macOS ${process.getSystemVersion()} (${process.arch})\n${game.title} [${game.core}] ${JSON.stringify(options)}${diagnose ? ' with the graphics recorder on' : ''}\n\n`);
  } catch {
    log = 'ignore';
  }
  const child = spawn(native.bin, args, { stdio: ['ignore', log, log] });
  const startedAt = Date.now();
  if (typeof log === 'number') fs.closeSync(log);
  nativePlayers.set(game.id, child);

  let reported = false;
  const failed = (why) => {
    if (reported || child.quitting || !libraryWindow) return;
    reported = true;
    const lastLines = tail(logFile, 8);
    dialog.showMessageBox(libraryWindow, {
      type: 'warning',
      message: `${game.title} stopped unexpectedly.`,
      detail: `${why}\n\nOption-click the game to try the built-in emulator instead.${lastLines ? `\n\n${lastLines}` : ''}\n\nFull log: ${logFile}`,
    });
  };
  // macOS can refuse to run the player that sits inside an app it hasn't
  // verified: the player is then stopped at once, before it prints anything.
  const blocked =
    'macOS stopped the built-in player before it could start. Open System Settings, go to Privacy & Security and scroll down: ' +
    'if it lists something from Devious Licks as blocked, click Open Anyway there, then click the game again.';
  child.on('exit', (code, signal) => {
    nativePlayers.delete(game.id);
    if (code === 4) failed("This Mac couldn't open a game window with OpenGL.");
    else if (code) failed(`The player reported a problem (code ${code}).`);
    else if (signal === 'SIGKILL' && Date.now() - startedAt < 5000) failed(blocked);
    else if (signal) failed(`The player crashed (${signal}).`);
  });
  child.on('error', (err) => {
    nativePlayers.delete(game.id);
    failed(err.code === 'EPERM' || err.code === 'EACCES' ? blocked : `The player couldn't start: ${err.message}`);
  });
}

let refreshing = null;
function refresh() {
  if (!refreshing) {
    const send = (p) => libraryWindow && libraryWindow.webContents.send('library:progress', p);
    refreshing = library
      .refresh(send)
      .then((r) => view(r))
      .catch((err) => ({ ...view(), error: friendlyError(err) }))
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
  local = new LocalGames(path.join(app.getPath('userData'), 'local-games'));
  await local.load();
  registerProtocol();

  ipcMain.handle('library:get', () => view());
  ipcMain.handle('local:add', (_e, files) => addLocal(Array.isArray(files) ? files.filter((f) => typeof f === 'string') : []));
  ipcMain.handle('local:remove', async (_e, id) => {
    const choice = await dialog.showMessageBox(libraryWindow, {
      type: 'question',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      message: 'Remove this game from your library?',
      detail: 'Your original file is not touched.',
    });
    if (choice.response === 0) await local.remove(id);
    return view();
  });
  ipcMain.handle('library:refresh', () => refresh());
  ipcMain.handle('game:play', (_e, id, opts) => openGame(id, { reset: Boolean(opts && opts.reset), diagnose: Boolean(opts && opts.diagnose) }));

  createLibraryWindow();
  if (SMOKE) smokeTest();
  app.on('activate', () => {
    if (!libraryWindow) createLibraryWindow();
  });
});

function smokeTest() {
  const finish = (ok, details) => {
    console.log(`[smoke] ${ok ? 'ok' : 'FAILED'} ${JSON.stringify({ version: app.getVersion(), chip: process.arch, ...details })}`);
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(ok ? 0 : 1);
  };
  const timer = setTimeout(() => finish(false, { why: 'the library window did not load within 45 seconds' }), 45000);
  libraryWindow.webContents.once('did-fail-load', (_e, code, text) => {
    clearTimeout(timer);
    finish(false, { why: `the library window failed to load: ${text} (${code})` });
  });
  libraryWindow.webContents.once('did-finish-load', async () => {
    clearTimeout(timer);
    try {
      const page = await libraryWindow.webContents.executeJavaScript(
        '({ bridge: typeof window.library === "object" && typeof window.library.play === "function", page: Boolean(document.getElementById("refresh")) })'
      );
      const n64Player = Boolean(nativeCoreFor({ core: 'n64' }));
      // (a copy run from the source folder has no built player; the packaged app must)
      finish(page.bridge && page.page && (n64Player || !app.isPackaged), { ...page, n64Player });
    } catch (err) {
      finish(false, { why: String((err && err.message) || err) });
    }
  });
}

app.on('before-quit', () => {
  for (const child of nativePlayers.values()) {
    child.quitting = true;
    child.kill('SIGTERM');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
