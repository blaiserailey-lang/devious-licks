// The library window. This file is the library's side of it: which games
// there are, starting one, adding and removing your own, refreshing the
// catalog, and the Update button. What it looks like and how it is steered
// is the dashboard's side (dash/main.js).

const $ = (id) => document.getElementById(id);
let state = { games: [] };
let filter = 'all';
let query = '';
let dash = null; // the dashboard, once it has started
let consoleName = (core) => String(core || '').toUpperCase();

// ---------- what is shown ----------
function shown() {
  const q = query.trim().toLowerCase();
  return state.games.filter((g) =>
    (filter === 'all' || consoleName(g.core) === filter) &&
    (!q || g.title.toLowerCase().includes(q) || (g.description || '').toLowerCase().includes(q)));
}

function consoles() {
  return [...new Set(state.games.map((g) => consoleName(g.core)))].sort();
}

function about() {
  return { total: state.games.length, filter, consoles: consoles(), query };
}

// Draws the library again. `focusId`: the game to put in front.
function render(focusId) {
  if (filter !== 'all' && !consoles().includes(filter)) filter = 'all'; // the last game of that console is gone
  $('synced').textContent = state.syncedAt
    ? `Last updated ${new Date(state.syncedAt).toLocaleString()} from ${state.source}`
    : `Catalog: ${state.source || ''}`;
  if (!dash) return;
  if (focusId) dash.showGame(focusId, shown(), about());
  else dash.setGames(shown(), about());
}

function showStatus(text, isError = false) {
  const s = $('status');
  s.hidden = !text;
  s.textContent = text || '';
  s.classList.toggle('error', isError);
}

let toastTimer;
function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 8000 : 5000);
}

function summarize(s) {
  if (!s) return null;
  const parts = [];
  if (s.added.length) parts.push(`New: ${s.added.join(', ')}`);
  if (s.updated.length) parts.push(`Updated: ${s.updated.join(', ')}`);
  if (s.removed.length) parts.push(`Removed: ${s.removed.join(', ')}`);
  return parts.length ? parts.join(' · ') : 'Your games are up to date.';
}

// ---------- the catalog ----------
// `quiet`: the look the app takes by itself when it opens. It only speaks up
// when something changed.
async function refresh(quiet = false) {
  const btn = $('refresh');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('spinning');
  btn.querySelector('span').textContent = 'Refreshing…';
  try {
    const result = await window.library.refresh();
    state = result;
    render();
    if (result.error) showStatus(result.error, true);
    else if (result.summary && result.summary.failed.length) showStatus(`Some games couldn't update: ${result.summary.failed.join('; ')}`, true);
    else showStatus('');
    const msg = summarize(result.summary);
    const changed = result.summary && (result.summary.added.length || result.summary.updated.length || result.summary.removed.length);
    if (msg && (!quiet || changed)) toast(msg);
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
    btn.querySelector('span').textContent = 'Refresh';
  }
}

window.library.onProgress((p) => {
  if (p.phase === 'game' && p.total) showStatus(`${p.message} (${p.done + 1} of ${p.total})`);
  else if (p.phase === 'start') showStatus(p.message);
});

// ---------- games added from a file ----------
async function addLocal(files) {
  try {
    const before = new Set(state.games.map((g) => g.id));
    const r = await window.library.addLocal(files);
    state = { ...state, games: r.games };
    const fresh = r.games.find((g) => g.local && !before.has(g.id));
    const parts = [];
    if (r.added.length) parts.push(`Added ${r.added.join(', ')}. To give it a picture, press Y or drop one onto it.`);
    if (r.skipped.length) parts.push(r.skipped.join(' · '));
    $('add-result').textContent = parts.join(' ');
    if (fresh) {
      // The new game has to be in sight, whatever was being looked for.
      filter = 'all';
      query = '';
      $('search').value = '';
    }
    render(fresh ? fresh.id : undefined);
    if (parts.length) toast(parts.join(' · '));
  } catch (err) {
    const text = `That couldn't be added: ${(err && err.message) || err}`;
    $('add-result').textContent = text;
    toast(text, true);
  }
}

async function removeLocal(game) {
  try {
    // (the app asks first whether it is really meant)
    state = { ...state, ...(await window.library.removeLocal(game.id)) };
    render();
  } catch (err) {
    toast(`${game.title} couldn't be removed: ${(err && err.message) || err}`, true);
  }
}

async function setCover(id, file) {
  try {
    const r = await window.library.setCover(id, file);
    state = { ...state, games: r.games };
    render();
    if (r.message) toast(r.message);
  } catch (err) {
    toast(`The picture couldn't be set: ${(err && err.message) || err}`, true);
  }
}

// Starting a game. Option: the built-in (web) emulator, from scratch. Shift: with the recorder on.
function play(game, mods) {
  return window.library.play(game.id, { reset: Boolean(mods && mods.reset), diagnose: Boolean(mods && mods.diagnose) });
}

$('add').onclick = () => addLocal();

// What is being dragged in: game files (anywhere on the window adds them), or
// pictures (on the Games screen, a picture becomes the picture of the game in
// front, when that game was added from a file).
let dragDepth = 0;
const isPicture = (f) => /^image\//.test(f.type || '') || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(f.name || '');
const draggingPictures = (e) => {
  const items = [...((e.dataTransfer && e.dataTransfer.items) || [])].filter((i) => i.kind === 'file');
  return items.length > 0 && items.every((i) => /^image\//.test(i.type || ''));
};
const pictureTarget = () => (dash && dash.page === 'games' && dash.game && dash.game.local ? dash.game : null);
const dragOver = () => {
  dragDepth = 0;
  $('dropzone').hidden = true;
  $('dash').classList.remove('picture-drag');
};
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  if (draggingPictures(e)) {
    const game = pictureTarget();
    $('dash').classList.add('picture-drag');
    $('dropzone-text').textContent = game ? `Drop the picture to give it to ${game.title}` : 'A picture goes onto a game you added: bring it to the front on the Games screen first';
  } else {
    $('dropzone-text').textContent = "Drop a game file to add it to this Mac's library";
  }
  $('dropzone').hidden = false;
});
// (No relatedTarget: the drag left the window. The count alone can be off when the library is redrawn under a drag.)
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget || --dragDepth <= 0) dragOver(); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragOver();
  // (As an array: a FileList itself does not make it across to the app's side.)
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  if (files.every(isPicture)) {
    const game = pictureTarget();
    if (game) setCover(game.id, files[0]);
    else if (dash && dash.page === 'games' && dash.game) toast(`${dash.game.title} comes from the Devious Licks catalog and keeps its own picture. Pictures go onto games you added (the ones marked "On this Mac").`);
    else toast(state.games.some((g) => g.local) ? 'To give a game you added a picture, bring it to the front on the Games screen, then drop the picture.' : 'Add a game first, then drop a picture onto it on the Games screen.');
    return;
  }
  addLocal(files);
});

// ---------- the Update button ----------
// One button; its label says what a click does next:
//   Update -> Checking… -> Update to 0.3.3 -> Updating… 40% -> (the app restarts on 0.3.3)
// The app looks for a new version by itself when it opens, so the button
// already reads "Update to 0.3.3" when there is one. Nothing is downloaded
// until it is clicked. What the button has to say in whole sentences goes
// into the notice at the top of the window (not the status line: a refresh wipes that).
let update = { phase: 'idle' };
const told = {}; // things that are said once

// A version the person switched off themselves (see offerToSwitchOff in main.js).
const byHand = (why) => /switched off by hand/.test(why || '');

function megabytes(bytes) {
  return `${Math.max(1, Math.round(bytes / 1048576))} MB`;
}

function notice(text, { error = false, page = false, detail = '' } = {}) {
  $('notice').hidden = !text;
  $('notice-text').textContent = text || '';
  $('notice').classList.toggle('error', error);
  $('notice').title = detail; // the technical reason, for whoever is asked to help
  $('notice-page').hidden = !page;
}

async function openPage() {
  try {
    await window.library.update.openPage();
  } catch {
    notice(`The download page didn't open. You can find it at ${update.page || 'the project page on GitHub'}.`, { error: true });
  }
}

function showUpdate(next) {
  if (next) update = next;
  const btn = $('update');
  const again = update.phase === 'available' && update.failedBefore;
  const label = {
    checking: 'Checking…',
    available: again ? `Try ${update.latest} again` : `Update to ${update.latest}`,
    downloading: `Updating… ${update.percent || 0}%`,
    ready: 'Restart to finish',
    download: `Get ${update.latest}`,
  }[update.phase] || 'Update';
  btn.querySelector('span').textContent = label;
  btn.disabled = update.phase === 'checking' || update.phase === 'downloading';
  btn.setAttribute('aria-busy', String(btn.disabled));
  btn.classList.toggle('spinning', update.phase === 'checking');
  btn.classList.toggle('ready', ['available', 'ready', 'download'].includes(update.phase) && !again);
  btn.title = {
    available: again
      ? `Version ${update.latest} was ${byHand(update.why) ? 'switched off on this Mac' : 'downloaded before but did not start on this Mac'}. Click to download it again and give it another go.`
      : `Version ${update.latest} is out${update.size ? ` (a download of up to ${megabytes(update.size)})` : ''}.${update.notes ? ` ${update.notes}` : ''}`,
    ready: `Version ${update.latest} is downloaded. Restart Devious Licks to start using it.`,
    download: `Version ${update.latest} needs a fresh download of the app.`,
  }[update.phase] || 'Get the newest version of Devious Licks';
  if (update.version) {
    $('version').textContent = `Version ${update.version}`;
    $('version').title = update.installed && update.installed !== update.version ? `Updated in place. The installed app is ${update.installed}.` : '';
    // (the home screen shows it too, small, and says when there is a newer one)
    $('home-version').textContent = `Version ${update.version}${['available', 'ready', 'download'].includes(update.phase) && !again ? ` · ${update.latest} is out: see Settings` : ''}`;
  }
  // Said once, when the app has just come back from an update, either way.
  if (update.fresh && !told.fresh) {
    told.fresh = true;
    toast(`Devious Licks is now on version ${update.version}.`);
  }
  if (update.passedOver && !told.passedOver && !byHand(update.passedOver.why)) {
    told.passedOver = true;
    const { version, why } = update.passedOver;
    const what = /^it was set aside/.test(why)
      ? `Version ${version} was downloaded but did not start on this Mac, so Devious Licks went back to version ${update.version}.`
      : `Version ${version} was downloaded but can't be used on this Mac (${why}), so Devious Licks is still on version ${update.version}.`;
    notice(`${what} You can try the update again, or get the full app from the download page.`, { error: true, page: true, detail: why });
  }
}

async function updateClick() {
  const api = window.library.update;
  // A plain "Update" looks first (unless the app already knows)...
  if (!['available', 'ready', 'download'].includes(update.phase)) {
    notice('');
    showUpdate(await api.check());
    // ...and a version that failed here before is not taken again without being asked for by name.
    if (update.phase === 'available' && update.failedBefore) {
      const before = byHand(update.why) ? 'it was switched off on this Mac' : 'it did not start on this Mac last time';
      notice(`Version ${update.latest} is the newest, but ${before}. Click "Try ${update.latest} again" to give it another go, or get the full app from the download page.`, { page: true, detail: update.why || '' });
      return;
    }
  }
  if (update.phase === 'available') {
    notice('');
    showUpdate(await api.install());
  }
  if (update.phase === 'ready') {
    // Starts the app again on the new version (it asks first when a game is open).
    toast(`Version ${update.latest} is in. Restarting…`);
    if (!(await api.restart())) toast(`Version ${update.latest} is ready. Click "Restart to finish" when you are.`);
  } else if (update.phase === 'none') {
    toast(update.unknown ? 'There is no update to install right now.' : `You have the newest version (${update.version}).`);
  } else if (update.phase === 'download') {
    notice(`Version ${update.latest} can't be put in with the Update button: it needs a fresh download. Get the DMG from the download page, quit Devious Licks, and install it the way you did the first time.`, { page: true });
    await openPage();
  } else if (update.phase === 'error') {
    const what = update.latest ? `The update to version ${update.latest} didn't go through.` : "Couldn't look for a new version.";
    notice(`${what} ${update.error} If it keeps happening, you can get the full app from the download page.`, { error: true, page: true });
  }
}

window.library.update.onState(showUpdate);
$('update').onclick = updateClick;
$('notice-page').onclick = openPage;
$('notice-close').onclick = () => notice('');

$('refresh').onclick = () => refresh();
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); refresh(); }
  // Command-F: the search field on the Games screen.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && dash && dash.page === 'games') { e.preventDefault(); dash.find(); }
});

// ---------- start ----------
// Everything above works without the dashboard. Should the dashboard fail to
// start, the window falls back to showing the Settings list as plain rows, so
// that the Update button is still there to click.
async function startDashboard() {
  const module = await import('./dash/main.js');
  consoleName = module.consoleName;
  dash = module.start({
    play,
    remove: removeLocal,
    picture: (game) => setCover(game.id),
    // Up and Down on the Games screen: one console at a time, then all again.
    filter: (delta) => {
      const all = ['all', ...consoles()];
      if (all.length < 3) return;
      filter = all[(all.indexOf(filter) + delta + all.length) % all.length];
      render();
    },
    // The search field: what fits, with the first of them in front.
    find: (text) => {
      query = text;
      const list = shown();
      dash.setGames(list, about(), list[0] && list[0].id);
    },
  });
}

(async () => {
  let drawn = false;
  try {
    await startDashboard();
    state = await window.library.get();
    render();
    drawn = true;
    refresh(true); // check for new games every time the app opens
  } catch (err) {
    // Whatever is wrong with the library, the Update button has to stay
    // usable: a newer version may be the cure.
    if (!dash) document.documentElement.classList.add('dl-fallback');
    notice("The library couldn't be opened on this Mac. Updating the app may fix it.", { error: true, page: true, detail: String((err && err.message) || err) });
    refresh(true).catch(() => {}); // a fresh copy of the catalog may be all it takes
  }
  showUpdate(await window.library.update.get());
  // The page is drawn and the app answers: say so. (A new version of the app
  // only counts as working once its window got this far.)
  if (drawn) window.library.up();
  showUpdate(await window.library.update.check()); // ...and look for a new version of the app
})();
