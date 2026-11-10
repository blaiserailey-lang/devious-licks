const CONSOLES = {
  nes: 'NES', fceumm: 'NES',
  snes: 'SNES', snes9x: 'SNES',
  gba: 'GBA', mgba: 'GBA',
  gb: 'Game Boy', gbc: 'Game Boy Color', gambatte: 'Game Boy',
  segaMD: 'Genesis', genesis_plus_gx: 'Genesis',
  n64: 'N64', mupen64plus_next: 'N64',
};
const consoleName = (core) => CONSOLES[core] || core.toUpperCase();

const $ = (id) => document.getElementById(id);
let state = { games: [] };
let filter = 'all';
let query = '';

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function renderFilters() {
  const consoles = [...new Set(state.games.map((g) => consoleName(g.core)))].sort();
  const nav = $('filters');
  nav.replaceChildren();
  if (consoles.length < 2) return;
  for (const name of ['all', ...consoles]) {
    const chip = el('button', { className: 'chip', textContent: name === 'all' ? 'All' : name });
    chip.setAttribute('aria-pressed', String(filter === name));
    chip.onclick = () => { filter = name; render(); };
    nav.append(chip);
  }
}

// A game's picture. Box art that is taller than the card's frame is shown
// whole, over a blurred copy of itself, instead of being cut down to its middle.
function art(game) {
  const img = el('img', { className: 'cover', src: game.cover, alt: '', loading: 'lazy' });
  const frame = el('div', { className: 'art' }, [img]);
  const shape = () => {
    if (img.naturalWidth > 480) frame.classList.add('smooth'); // a photo or a painting, not pixel art
    if (img.naturalHeight > img.naturalWidth * 0.85 && !frame.classList.contains('whole')) {
      frame.classList.add('whole');
      frame.prepend(el('img', { className: 'backdrop', src: game.cover, alt: '' }));
    }
  };
  // (A picture the window has already loaded is shaped at once: drawing the library again must not flash it cropped.)
  if (img.complete && img.naturalWidth) shape();
  else img.addEventListener('load', shape);
  img.addEventListener('error', () => frame.replaceWith(el('div', { className: 'cover placeholder', textContent: game.title.slice(0, 1) })));
  return frame;
}

const PICTURE_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5.3" cy="6.2" r="1.3" fill="currentColor"/><path d="M2.5 12l3.4-3.3 2.3 2.1 2.6-3 2.7 4.2z" fill="currentColor"/></svg>';

async function setCover(id, file) {
  try {
    const r = await window.library.setCover(id, file);
    state = { ...state, games: r.games };
    render();
    if (r.message) toast(r.message);
  } catch (err) {
    toast(`The picture couldn't be set: ${(err && err.message) || err}`);
  }
}

function card(game) {
  const cover = game.cover ? art(game) : el('div', { className: 'cover placeholder', textContent: game.title.slice(0, 1) });
  const tags = el('div', { className: 'tags' }, [
    el('span', { className: 'tag', textContent: consoleName(game.core) }),
    game.version ? el('span', { className: 'tag', textContent: `v${game.version}` }) : null,
    game.players > 1 ? el('span', { className: 'tag', textContent: `${game.players}P` }) : null,
    game.local ? el('span', { className: 'tag local', textContent: 'On this Mac' }) : null,
  ]);
  const node = el('button', { className: 'card', title: `Play ${game.title}` }, [
    cover,
    el('span', { className: 'play' }),
    game.status ? el('span', { className: `badge ${game.status}`, textContent: game.status }) : null,
    el('div', { className: 'meta' }, [
      el('div', { className: 'title', textContent: game.title }),
      game.description ? el('div', { className: 'desc', textContent: game.description }) : null,
      tags,
    ]),
  ]);
  node.onclick = (e) =>
    window.library
      .play(game.id, { reset: e.altKey, diagnose: e.shiftKey })
      .catch((err) => toast(`${game.title} couldn't be started: ${(err && err.message) || err}`));
  if (game.local) {
    node.dataset.local = game.id;
    const picture = el('span', { className: 'picture', title: game.cover ? 'Change the picture (press P, or drop one here)' : 'Choose a picture (press P, or drop one here)' });
    picture.innerHTML = PICTURE_ICON;
    picture.onclick = (e) => {
      e.stopPropagation();
      setCover(game.id);
    };
    node.append(picture);
    node.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() !== 'p' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      e.preventDefault();
      setCover(game.id);
    });
    const remove = el('span', { className: 'remove', title: 'Remove from library', textContent: '×' });
    remove.onclick = async (e) => {
      e.stopPropagation();
      state = { ...state, ...(await window.library.removeLocal(game.id)) };
      render();
    };
    node.append(remove);
  }
  return node;
}

function render() {
  renderFilters();
  const q = query.trim().toLowerCase();
  const games = state.games.filter((g) =>
    (filter === 'all' || consoleName(g.core) === filter) &&
    (!q || g.title.toLowerCase().includes(q) || (g.description || '').toLowerCase().includes(q)));
  $('grid').replaceChildren(...games.map(card));
  $('empty').hidden = games.length > 0;
  if (state.games.length && !games.length) $('empty-text').textContent = 'No games match your search.';
  $('subtitle').textContent = `${state.games.length} game${state.games.length === 1 ? '' : 's'}`;
  $('synced').textContent = state.syncedAt
    ? `Last updated ${new Date(state.syncedAt).toLocaleString()} from ${state.source}`
    : `Catalog: ${state.source || ''}`;
}

function showStatus(text, isError = false) {
  const s = $('status');
  s.hidden = !text;
  s.textContent = text || '';
  s.classList.toggle('error', isError);
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

function summarize(s) {
  if (!s) return null;
  const parts = [];
  if (s.added.length) parts.push(`New: ${s.added.join(', ')}`);
  if (s.updated.length) parts.push(`Updated: ${s.updated.join(', ')}`);
  if (s.removed.length) parts.push(`Removed: ${s.removed.join(', ')}`);
  return parts.length ? parts.join(' · ') : 'Your games are up to date.';
}

async function refresh() {
  const btn = $('refresh');
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
    if (msg) toast(msg);
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

async function addLocal(files) {
  try {
    const r = await window.library.addLocal(files);
    state = { ...state, games: r.games };
    render();
    const parts = [];
    if (r.added.length) parts.push(`Added ${r.added.join(', ')} (drop a picture onto it to give it a cover)`);
    if (r.skipped.length) parts.push(r.skipped.join(' · '));
    if (parts.length) toast(parts.join(' · '));
  } catch (err) {
    toast(`That couldn't be added: ${(err && err.message) || err}`);
  }
}

$('add').onclick = () => addLocal();
let dragDepth = 0;
// What is being dragged in: game files (anywhere on the window adds them), or
// pictures (dropped on a game that was added from a file, they become its picture).
const isPicture = (f) => /^image\//.test(f.type || '') || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(f.name || '');
const draggingPictures = (e) => {
  const items = [...((e.dataTransfer && e.dataTransfer.items) || [])].filter((i) => i.kind === 'file');
  return items.length > 0 && items.every((i) => /^image\//.test(i.type || ''));
};
const dragOver = () => {
  dragDepth = 0;
  $('dropzone').hidden = true;
  document.body.classList.remove('picture-drag');
  for (const c of document.querySelectorAll('.card.target')) c.classList.remove('target');
};
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  if (draggingPictures(e)) document.body.classList.add('picture-drag');
  else $('dropzone').hidden = false;
});
// (No relatedTarget: the drag left the window. The count alone can be off when the library is redrawn under a drag.)
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget || --dragDepth <= 0) dragOver(); });
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!document.body.classList.contains('picture-drag')) return;
  const over = e.target instanceof Element ? e.target.closest('.card[data-local]') : null;
  for (const c of document.querySelectorAll('.card.target')) if (c !== over) c.classList.remove('target');
  if (over) over.classList.add('target');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragOver();
  // (As an array: a FileList itself does not make it across to the app's side.)
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  if (files.every(isPicture)) {
    const onto = e.target instanceof Element ? e.target.closest('.card[data-local]') : null;
    if (onto) setCover(onto.dataset.local, files[0]);
    else toast(state.games.some((g) => g.local) ? 'Drop the picture onto a game you added (the ones marked "On this Mac") to give it that picture.' : 'Add a game first, then drop a picture onto it to give it a cover.');
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
// into the notice above the games (not the status line: a refresh wipes that).
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

$('refresh').onclick = refresh;
$('search').oninput = (e) => { query = e.target.value; render(); };
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); refresh(); }
});

(async () => {
  let drawn = false;
  try {
    state = await window.library.get();
    render();
    drawn = true;
    refresh(); // check for new games every time the app opens
  } catch (err) {
    // Whatever is wrong with the library, the Update button has to stay
    // usable: a newer version may be the cure.
    notice("The library couldn't be opened on this Mac. Updating the app may fix it.", { error: true, page: true, detail: String((err && err.message) || err) });
    refresh().catch(() => {}); // a fresh copy of the catalog may be all it takes
  }
  showUpdate(await window.library.update.get());
  // The page is drawn and the app answers: say so. (A new version of the app
  // only counts as working once its window got this far.)
  if (drawn) window.library.up();
  showUpdate(await window.library.update.check()); // ...and look for a new version of the app
})();
