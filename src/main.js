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
const { makeFetch } = require('./transport');
const pkg = require('../package.json');

// This code runs either from the installed app or from an update pack in the
// app's data folder. boot.js decides which, and says so here (see boot.js).
const boot = global.devious || {
  api: 0, bundledVersion: pkg.version, updates: null, pack: null, skipped: [], rules: packs,
  accepts: () => '', started() {}, failed() {}, excused() {}, restartInstalled() {},
};
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
// (Only with a data folder of its own, named in DL_USER_DATA: the test must
// never be able to put its made-up versions into somebody's real library.)
const UPDATE_TEST = process.argv.includes('--update-test') && Boolean(process.env.DL_USER_DATA);

// What the update test reads: the console, and the file named in DL_TEST_LOG.
function say(line) {
  if (!UPDATE_TEST) return;
  console.log(line);
  try {
    if (process.env.DL_TEST_LOG) fs.appendFileSync(process.env.DL_TEST_LOG, `${line}\n`);
  } catch {
    /* the console has it */
  }
}

// One copy of the app at a time. Two sharing a data folder would get in each
// other's way (two downloads into one folder, one tidying away what the other
// needs). A second start hands over to the copy that is already open and
// quits; it says nothing about the update pack it ran from, so it is not
// counted as one of that pack's starts (boot.excused).
// (The lock keeps a socket in the temporary folder, and the length of such a
// path has a hard limit. Where that folder's name is unusually long, the app
// does without the lock rather than not start at all.)
const lockable = path.join(app.getPath('temp'), 'scoped_dirXXXXXX', 'SingletonSocket').length < 100;
const FIRST = SMOKE || !lockable || app.requestSingleInstanceLock();
if (!FIRST) {
  boot.excused();
  say(`[update-test] second copy ${process.pid}: handing over to the one that is open`);
  app.exit(0);
}

// Calls `then` once the app has been awake for `seconds` (counted in short
// steps: one long timer would also count the time the Mac spent asleep).
// Returns a function that calls it off.
function after(seconds, then) {
  const step = Math.min(5, seconds);
  let left = seconds;
  const timer = setInterval(() => {
    left -= step;
    if (left > 0) return;
    clearInterval(timer);
    then();
  }, step * 1000);
  return () => clearInterval(timer);
}

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
  libraryWindow.webContents.on('render-process-gone', (_e, details) => windowDied(details && details.reason));
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

// ---------- the Update button (see updater.js, transport.js and packs.js) ----------
const REPO = `${pkg.deviousLicks.catalog.owner}/${pkg.deviousLicks.catalog.repo}`;
const RELEASES = `https://github.com/${REPO}/releases`;
// Only the update test may point the app at another place, and only at this machine.
const TEST_FEED = UPDATE_TEST && /^http:\/\/127\.0\.0\.1:\d{2,5}\/[\w./-]*$/.test(process.env.DL_UPDATE_FEED || '') ? process.env.DL_UPDATE_FEED : null;
// Where a download may come from, asked at every step of the way. GitHub
// passes a request for a release file on to its download servers, and where
// those live is GitHub's business, so the rule is "encrypted all the way",
// not a list of names. (The update test talks to its stand-in on this machine.)
const allowed = (url) => (TEST_FEED ? String(url).startsWith(new URL('/', TEST_FEED).toString()) : /^https:\/\//i.test(String(url)));
// Has the pack this runs from already shown, on an earlier start, that it works on this Mac?
const proven = Boolean(boot.pack) && packs.readState(originalFs, boot.updates).good === pkg.version;
let updater;

function makeUpdater() {
  // (the update test can switch the copying off, to have the player really downloaded)
  const reuse = !(UPDATE_TEST && process.env.DL_TEST_NO_REUSE);
  return new Updater({
    fs: originalFs,
    fetch: makeFetch(net, allowed),
    dir: boot.updates || path.join(app.getPath('userData'), 'updates'),
    feed: TEST_FEED || `${RELEASES}/latest/download/update.json`,
    fileUrl: (version, name) =>
      TEST_FEED ? new URL(`v${version}/${encodeURIComponent(name)}`, TEST_FEED).toString() : `${RELEASES}/download/v${version}/${encodeURIComponent(name)}`,
    allowed,
    running: {
      version: pkg.version,
      bundledVersion: boot.bundledVersion,
      electron: process.versions.electron,
      // Files that are the same in the new version are copied from here.
      places: reuse ? [...new Set([HOME, app.isPackaged ? process.resourcesPath : null].filter(Boolean))] : [],
      skipped: Array.isArray(boot.skipped) ? boot.skipped : [],
      accepts: (info) => (typeof boot.accepts === 'function' ? boot.accepts(info) : ''),
      fresh: Boolean(boot.pack) && !proven,
    },
    onChange: (state) => libraryWindow && !libraryWindow.isDestroyed() && libraryWindow.webContents.send('update:state', state),
    page: `${RELEASES}/latest`,
  });
}

let restarting = false;
async function restartIntoUpdate() {
  if (restarting) return true;
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
  if (restarting) return true;
  restarting = true;
  say(`[update-test] installed ${updater.view().latest}, restarting`);
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--installed-code') });
  app.quit();
  return true;
}

// ---------- an update pack has to prove itself ----------
// A pack that has not worked on this Mac before is watched while it starts:
// its window has to come up within a minute, draw its page, and stay up for a
// little while, without the code failing on the way. Then it counts as good
// (boot.started) and the pack before it can go. One that doesn't get that
// far is set aside, and the app starts again without it (boot.failed). A
// pack that has worked here before only has to bring its window up.
const SETTLE = UPDATE_TEST ? 2 : 15; // seconds the window has to stay up
let stage = 'starting'; // -> 'settling' (a new pack on probation) -> 'up'
const stumbled = (err) => boot.failed(`failed while starting: ${String((err && err.stack) || err).slice(0, 240)}`);
let callOff = () => {};
if (FIRST && boot.pack) {
  callOff = after(60, () => boot.failed('its window did not come up within a minute'));
  if (!proven) {
    process.on('uncaughtException', stumbled);
    process.on('unhandledRejection', stumbled);
  }
}

// The library window has drawn its page and says so ('app:up', sent by app.js).
function pageUp() {
  if (stage !== 'starting') return;
  callOff();
  if (!boot.pack || proven) {
    nowUp();
    return;
  }
  stage = 'settling';
  callOff = after(SETTLE, nowUp);
}

function nowUp() {
  if (stage === 'up') return;
  stage = 'up';
  callOff();
  process.removeListener('uncaughtException', stumbled);
  process.removeListener('unhandledRejection', stumbled);
  boot.started();
  // (A copy run from the source folder shares the installed app's data
  // folder: it leaves that app's packs alone.)
  const ownFolder = app.isPackaged || Boolean(process.env.DL_USER_DATA);
  if (ownFolder) updater.tidy();
  const settled = ownFolder && !boot.pack && process.argv.includes('--installed-code') ? offerToSwitchOff() : Promise.resolve();
  if (UPDATE_TEST) settled.then(updateTest);
}

// Started with --installed-code: the way out when an update misbehaves. The
// update is still on this Mac and would start again next time (the button
// would even say "Restart to finish"), so ask whether it should stay. One
// that is switched off is treated like one that failed: its files go, and the
// button offers it again by name.
const BY_HAND = 'switched off by hand';
async function offerToSwitchOff() {
  try {
    const dir = updater.dir;
    const pack = packs.choose({ fs: originalFs, dir, bundledVersion: boot.bundledVersion, electron: process.versions.electron });
    if (!pack) return;
    let stop = UPDATE_TEST && process.env.DL_TEST_ANSWER === 'stop'; // (the update test answers for itself)
    if (!UPDATE_TEST) {
      const choice = await dialog.showMessageBox(libraryWindow, {
        type: 'question',
        buttons: [`Stop using ${pack.version}`, `Keep ${pack.version}`],
        defaultId: 1,
        cancelId: 1,
        message: 'Devious Licks is running without its update.',
        detail:
          `This is version ${boot.bundledVersion}, the one the app was installed with. Version ${pack.version} is also on this Mac ` +
          'and starts again the next time the app opens. If it is the one giving you trouble, you can stop using it. ' +
          'The Update button brings it back whenever you want.',
      });
      stop = choice.response === 0;
    }
    if (!stop) return;
    if (!packs.markBad(originalFs, dir, pack.version, BY_HAND)) {
      if (!UPDATE_TEST) {
        await dialog.showMessageBox(libraryWindow, {
          type: 'warning',
          message: `Version ${pack.version} could not be switched off.`,
          detail: `The app can't write to its data folder. To switch it off yourself, quit Devious Licks and delete this folder:\n\n${dir}`,
        });
      }
      return;
    }
    say(`[update-test] switched off ${pack.version}`);
    updater.tidy();
    await updater.check();
  } catch (err) {
    console.error(`[update] could not offer to switch the update off: ${(err && err.message) || err}`);
  }
}

// The library window's page went away by itself (it crashed, or was killed).
function windowDied(reason) {
  if (stage !== 'up' && reason !== 'clean-exit') boot.failed(`its window stopped while starting (${reason || 'no reason given'})`);
}

let ready = false; // the library and the handlers below are in place
app.on('second-instance', () => {
  say('[update-test] a second copy was opened: showing this one instead');
  if (!ready) return;
  if (!libraryWindow) {
    createLibraryWindow();
    return;
  }
  if (libraryWindow.isMinimized()) libraryWindow.restore();
  libraryWindow.show();
  libraryWindow.focus();
});

app.whenReady().then(async () => {
  if (!FIRST) return;
  updater = makeUpdater();
  // The About box reads the installed app's version; say which one is really running.
  if (boot.pack) app.setAboutPanelOptions({ applicationVersion: pkg.version, version: `installed app ${boot.bundledVersion}` });
  library = new Library(path.join(app.getPath('userData'), 'library'), makeSource());
  await library.load();
  local = new LocalGames(path.join(app.getPath('userData'), 'local-games'));
  await local.load();
  registerProtocol();

  ipcMain.handle('library:get', () => view());
  ipcMain.on('app:up', (event) => {
    if (libraryWindow && !libraryWindow.isDestroyed() && event.sender === libraryWindow.webContents) pageUp();
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

  ready = true;
  createLibraryWindow();
  if (SMOKE) smokeTest();
  app.on('activate', () => {
    if (!libraryWindow) createLibraryWindow();
  });
});

function smokeTest() {
  const finish = (ok, details) => {
    console.log(`[smoke] ${ok ? 'ok' : 'FAILED'} ${JSON.stringify({ version: pkg.version, chip: process.arch, ...details })}`);
    // Only the throw-away folder boot.js made for this run, never one somebody named with DL_USER_DATA.
    const data = app.getPath('userData');
    if (path.basename(data).startsWith('devious-licks-smoke-')) fs.rmSync(data, { recursive: true, force: true });
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
      // The release build also has the app fetch the start of a real file
      // from GitHub, down the same road the Update button takes.
      const probe = /^https:\/\/github\.com\//.test(process.env.DL_SMOKE_FETCH || '') ? await probeFetch(process.env.DL_SMOKE_FETCH) : null;
      // (a copy run from the source folder has no built player; the packaged app must)
      finish(page.bridge && page.page && (n64Player || !app.isPackaged) && (!probe || probe.ok), { ...page, n64Player, ...(probe ? { fetch: probe } : {}) });
    } catch (err) {
      finish(false, { why: String((err && err.message) || err) });
    }
  });
}

// Fetches the first bytes of `url` the way the Update button fetches its
// files (transport.js) and says how it went: the answer, how much arrived,
// and the hosts the request was passed on to.
async function probeFetch(url) {
  const hops = [];
  const fetch = makeFetch(net, (to) => {
    try {
      hops.push(new URL(String(to)).host);
    } catch {
      hops.push('?');
    }
    return /^https:\/\//i.test(String(to));
  });
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 30000);
  try {
    const res = await fetch(url, { signal: control.signal });
    const reader = res.body ? res.body.getReader() : null;
    let bytes = 0;
    while (reader && bytes < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    control.abort(); // the rest is not needed
    return { ok: res.status === 200 && bytes > 0, status: res.status, bytes, hops };
  } catch (err) {
    return { ok: false, why: String((err && err.message) || err), hops };
  } finally {
    clearTimeout(timer);
  }
}

// The update test, one start at a time: say what is running; when there is
// something newer that hasn't failed here before, click the Update button in
// the window and let the page take it from there, restart included;
// otherwise report where things ended up and quit. The release workflow
// reads the lines this writes (DL_TEST_LOG) and judges them
// (scripts/test-update.js).
async function updateTest() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inPage = (code) => libraryWindow.webContents.executeJavaScript(code);
  const giveUp = setTimeout(() => {
    say('[update-test] FAILED: no result after three minutes');
    app.exit(1);
  }, 180000);
  try {
    say(`[update-test] running ${pkg.version} from ${boot.pack ? 'an update pack' : 'the installed code'}`);
    if (!TEST_FEED) throw new Error('DL_UPDATE_FEED has to be an http://127.0.0.1:<port>/ address');
    // For the test of the way back: leave for the installed code, the way
    // the "Restart Without Updates" item in the Dock does.
    if (process.env.DL_TEST_LEAVE && boot.pack) {
      say(`[update-test] leaving ${pkg.version} for the installed code`);
      clearTimeout(giveUp);
      boot.restartInstalled();
      return;
    }
    // For the test of two copies at once: stay open until the file named in DL_TEST_HOLD appears.
    if (process.env.DL_TEST_HOLD) {
      say(`[update-test] holding ${process.pid}`);
      while (!fs.existsSync(process.env.DL_TEST_HOLD)) await sleep(200);
    }
    let found = await updater.check();
    if (found.phase === 'available' && !found.failedBefore) {
      // The way a person does it: one click on the button. The page downloads
      // the update and asks for the restart itself (restartIntoUpdate).
      await inPage("document.getElementById('update').click()");
      const clicked = Date.now();
      let readyAt = 0;
      for (;;) {
        await sleep(200);
        found = updater.view();
        if (found.phase === 'error') break; // reported below
        if (found.phase === 'ready' && !readyAt) readyAt = Date.now();
        if (readyAt && Date.now() - readyAt > 30000) throw new Error('the update was downloaded, but the window did not restart the app');
        if (!readyAt && Date.now() - clicked > 120000) throw new Error(`the click on Update led nowhere (the update's state is "${found.phase}")`);
      }
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
    const page = await inPage(`new Promise((resolve) => {
      const start = Date.now();
      (function look() {
        const button = document.getElementById('update');
        const version = document.getElementById('version');
        const notice = document.getElementById('notice');
        if ((version && version.textContent) || Date.now() - start > 10000) {
          resolve({
            button: Boolean(button),
            label: button ? button.textContent.trim() : null,
            shown: version ? version.textContent : null,
            notice: notice && !notice.hidden ? notice.textContent.trim().replace(/\\s+/g, ' ') : null,
          });
        } else setTimeout(look, 50);
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
      why: found.why || null,
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
  // Quitting while a new pack is still on probation says nothing about it either way.
  if (stage === 'settling') boot.excused();
  for (const child of nativePlayers.values()) {
    child.quitting = true;
    child.kill('SIGTERM');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
