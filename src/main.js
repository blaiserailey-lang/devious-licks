const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const originalFs = require('original-fs'); // sees app.asar as a file (Electron's own fs treats it as a folder)
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { Library, githubSource, folderSource } = require('./catalog');
const { LocalGames, EXTENSIONS } = require('./local');
const n64 = require('./n64');
const packs = require('./packs');
const { Updater } = require('./updater');
const pkg = require('../package.json');

// This code runs either from the installed app or from an update pack in the
// app's data folder. boot.js decides which, and says so here (see boot.js).
const boot = global.devious || { api: 0, bundledVersion: pkg.version, updates: null, pack: null, skipped: [], started() {}, failed() {} };
const ROOT = path.join(__dirname, '..');
// The folder that holds app.asar and player/ side by side: Contents/Resources
// in the installed app, <pack> in an update pack. (null when run from source.)
const HOME = /\.asar$/.test(ROOT) ? path.join(ROOT, '..') : null;

// "--smoke-test" (the release workflow runs the packaged app with it): start
// as usual, check that the library window came up with its bridge to this
// process and that the built-in N64 player is where the app looks for it,
// print the verdict and quit. (boot.js keeps its files out of the real library.)
const SMOKE = process.argv.includes('--smoke-test');
// "--update-test" (also the release workflow): take an update from a stand-in
// for GitHub on this machine, restart into it and report. See updateTest().
const UPDATE_TEST = process.argv.includes('--update-test');

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
const PLAYER_DIR = HOME ? path.join(HOME, 'player') : path.join(ROOT, 'player', 'dist');
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
    fs.writeSync(log, `Devious Licks ${pkg.version}${boot.pack ? ` (update on installed app ${boot.bundledVersion})` : ''} on macOS ${process.getSystemVersion()} (${process.arch})\n${game.title} [${game.core}] ${JSON.stringify(options)}${diagnose ? ' with the graphics recorder on' : ''}\n\n`);
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

// ---------- the Update button (see updater.js and packs.js) ----------
const REPO = `${pkg.deviousLicks.catalog.owner}/${pkg.deviousLicks.catalog.repo}`;
const RELEASES = `https://github.com/${REPO}/releases`;
// Only the update test may point the app at another place, and only at this machine.
const TEST_FEED = UPDATE_TEST && /^http:\/\/127\.0\.0\.1:\d{2,5}\/[\w./-]*$/.test(process.env.DL_UPDATE_FEED || '') ? process.env.DL_UPDATE_FEED : null;
let updater;

function makeUpdater() {
  return new Updater({
    fs: originalFs,
    fetch: (url, options) => net.fetch(url, options),
    dir: boot.updates || path.join(app.getPath('userData'), 'updates'),
    feed: TEST_FEED || `${RELEASES}/latest/download/update.json`,
    fileUrl: (version, name) =>
      TEST_FEED ? new URL(`v${version}/${encodeURIComponent(name)}`, TEST_FEED).toString() : `${RELEASES}/download/v${version}/${encodeURIComponent(name)}`,
    // GitHub hands release files out from its own download servers.
    allowed: (url) =>
      TEST_FEED ? url.startsWith(new URL('/', TEST_FEED).toString()) : /^https:\/\/([a-z0-9-]+\.)*(github\.com|githubusercontent\.com)\//.test(url),
    // Files that are the same in the new version are copied from here.
    running: {
      version: pkg.version,
      bundledVersion: boot.bundledVersion,
      electron: process.versions.electron,
      places: [...new Set([HOME, app.isPackaged ? process.resourcesPath : null].filter(Boolean))],
    },
    onChange: (state) => libraryWindow && !libraryWindow.isDestroyed() && libraryWindow.webContents.send('update:state', state),
    page: `${RELEASES}/latest`,
  });
}

async function restartIntoUpdate() {
  if (nativePlayers.size || playerWindows.size) {
    const choice = await dialog.showMessageBox(libraryWindow, {
      type: 'question',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: 'Restart Devious Licks to finish the update?',
      detail: 'A game is open. Restarting closes it. Battery saves are kept; anything else since your last save in the game is lost.',
    });
    if (choice.response !== 0) return false;
  }
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--installed-code') });
  app.quit();
  return true;
}

// An update pack has to prove itself: its window has to come up within a
// minute of starting. If it doesn't, or the code fails on the way there, the
// pack is set aside and the app starts again without it (boot.failed).
let up = false;
const stumbled = (err) => boot.failed(`failed while starting: ${String((err && err.stack) || err).slice(0, 240)}`);
const upTimer = boot.pack ? setTimeout(() => boot.failed('its window did not come up within a minute'), 60000) : null;
if (boot.pack) {
  process.on('uncaughtException', stumbled);
  process.on('unhandledRejection', stumbled);
}

function cameUp() {
  if (up) return;
  up = true;
  clearTimeout(upTimer);
  process.removeListener('uncaughtException', stumbled);
  process.removeListener('unhandledRejection', stumbled);
  boot.started();
  updater.tidy();
  if (UPDATE_TEST) updateTest();
}

app.whenReady().then(async () => {
  updater = makeUpdater();
  library = new Library(path.join(app.getPath('userData'), 'library'), makeSource());
  await library.load();
  local = new LocalGames(path.join(app.getPath('userData'), 'local-games'));
  await local.load();
  registerProtocol();

  ipcMain.handle('library:get', () => {
    cameUp(); // the window is up and talking to this process
    return view();
  });
  ipcMain.handle('update:get', () => updater.view());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('update:restart', () => restartIntoUpdate());
  ipcMain.handle('update:page', () => shell.openExternal(`${RELEASES}/latest`));
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
    console.log(`[smoke] ${ok ? 'ok' : 'FAILED'} ${JSON.stringify({ version: pkg.version, chip: process.arch, ...details })}`);
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

// The update test, one start at a time: say what is running; when the stand-in
// for GitHub has something newer that hasn't failed here before, take it and
// restart; otherwise report where things ended up and quit. The release
// workflow reads the lines this writes (DL_TEST_LOG) and judges them.
async function updateTest() {
  const say = (line) => {
    console.log(line);
    try {
      if (process.env.DL_TEST_LOG) fs.appendFileSync(process.env.DL_TEST_LOG, `${line}\n`);
    } catch {
      /* the console has it */
    }
  };
  const giveUp = setTimeout(() => {
    say('[update-test] FAILED: no result after 90 seconds');
    app.exit(1);
  }, 90000);
  try {
    say(`[update-test] running ${pkg.version} from ${boot.pack ? 'an update pack' : 'the installed code'}`);
    if (!TEST_FEED) throw new Error('DL_UPDATE_FEED has to be an http://127.0.0.1:<port>/ address');
    const found = await updater.check();
    if (found.phase === 'available' && !found.failedBefore) {
      const done = await updater.install();
      if (done.phase !== 'ready') throw new Error(`the update did not install: ${done.error}`);
      say(`[update-test] installed ${done.latest}, restarting`);
      clearTimeout(giveUp);
      app.relaunch();
      app.exit(0);
      return;
    }
    // Where things ended up. The player has to run from wherever this code
    // found it: for a pack that is the copy the update brought along.
    const native = nativeCoreFor({ core: 'n64' });
    let player = null;
    if (native) {
      const run = spawnSync(native.bin, ['--check', '--core', native.core], { encoding: 'utf8', timeout: 30000 });
      player = run.status === 0 ? run.stdout.trim() : `FAILED (${run.status === null ? run.signal || (run.error && run.error.code) : run.status}) ${String(run.stderr || '').trim().slice(-200)}`;
    }
    // What the window shows (it fills in the version a moment after it loads).
    const page = await libraryWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const start = Date.now();
      (function look() {
        const button = document.getElementById('update');
        const version = document.getElementById('version');
        if ((version && version.textContent) || Date.now() - start > 10000) resolve({ button: Boolean(button), shown: version ? version.textContent : null });
        else setTimeout(look, 50);
      })();
    })`);
    say(`[update-test] done ${JSON.stringify({
      pid: process.pid,
      version: pkg.version,
      installed: boot.bundledVersion,
      pack: boot.pack ? boot.pack.dir : null,
      phase: found.phase,
      latest: found.latest || null,
      failedBefore: Boolean(found.failedBefore),
      error: found.error || null,
      bad: Object.keys(packs.readState(originalFs, updater.dir).bad),
      skipped: (boot.skipped || []).map((s) => s.version),
      playerDir: native ? path.dirname(native.bin) : null,
      player,
      ...page,
    })}`);
    clearTimeout(giveUp);
    app.exit(0);
  } catch (err) {
    say(`[update-test] FAILED: ${String((err && err.message) || err)}`);
    clearTimeout(giveUp);
    app.exit(1);
  }
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
