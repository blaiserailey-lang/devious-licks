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

function card(game) {
  const cover = game.cover
    ? el('img', { className: 'cover', src: game.cover, alt: '', loading: 'lazy' })
    : el('div', { className: 'cover placeholder', textContent: game.title.slice(0, 1) });
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
  node.onclick = (e) => window.library.play(game.id, { reset: e.altKey, diagnose: e.shiftKey });
  if (game.local) {
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
  return parts.length ? parts.join(' · ') : 'Everything is up to date.';
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
  const r = await window.library.addLocal(files);
  state = { ...state, games: r.games };
  render();
  const parts = [];
  if (r.added.length) parts.push(`Added ${r.added.join(', ')}`);
  if (r.skipped.length) parts.push(r.skipped.join(' · '));
  if (parts.length) toast(parts.join(' · '));
}

$('add').onclick = () => addLocal();
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropzone').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  if (e.dataTransfer.files.length) addLocal(e.dataTransfer.files);
});

// ---------- the Update button ----------
// One button; its label says what a click does next:
//   Update -> Checking… -> Update to 0.3.3 -> Updating… 40% -> (the app restarts on 0.3.3)
// The app looks for a new version by itself when it opens, so the button
// already reads "Update to 0.3.3" when there is one. Nothing is downloaded
// until it is clicked.
let update = { phase: 'idle' };

function megabytes(bytes) {
  return `${Math.max(1, Math.round(bytes / 1048576))} MB`;
}

function showUpdate(next) {
  if (next) update = next;
  const btn = $('update');
  const label = {
    checking: 'Checking…',
    available: `Update to ${update.latest}`,
    downloading: `Updating… ${update.percent || 0}%`,
    ready: 'Restart to finish',
    download: `Get ${update.latest}`,
  }[update.phase] || 'Update';
  btn.querySelector('span').textContent = label;
  btn.disabled = update.phase === 'checking' || update.phase === 'downloading';
  btn.classList.toggle('spinning', update.phase === 'checking');
  btn.classList.toggle('ready', ['available', 'ready', 'download'].includes(update.phase));
  btn.title = {
    available: `Version ${update.latest} is out${update.size ? ` (a download of up to ${megabytes(update.size)})` : ''}.${update.notes ? ` ${update.notes}` : ''}`,
    ready: `Version ${update.latest} is downloaded. Restart Devious Licks to start using it.`,
    download: `Version ${update.latest} needs a fresh download of the app.`,
  }[update.phase] || 'Get the newest version of Devious Licks';
  if (update.version) {
    $('version').textContent = `Version ${update.version}`;
    $('version').title = update.installed && update.installed !== update.version ? `Updated in place. The installed app is ${update.installed}.` : '';
  }
}

async function updateClick() {
  const api = window.library.update;
  // Look (unless the app already knows), then download.
  if (!['available', 'ready', 'download'].includes(update.phase)) showUpdate(await api.check());
  if (update.phase === 'available') showUpdate(await api.install());
  if (update.phase === 'ready') {
    // Starts the app again on the new version (it asks first when a game is open).
    if (!(await api.restart())) toast(`Version ${update.latest} is ready. Click "Restart to finish" when you are.`);
  } else if (update.phase === 'none') {
    toast(`You have the newest version (${update.version}).`);
  } else if (update.phase === 'download') {
    await api.openPage();
    showStatus(`Version ${update.latest} can't be put in with the Update button: it needs a fresh download. The download page is open in your browser. Get the DMG there and install it the way you did the first time.`);
  } else if (update.phase === 'error') {
    showStatus(`The update didn't work. ${update.error}`, true);
  }
}

window.library.update.onState(showUpdate);
$('update').onclick = updateClick;

$('refresh').onclick = refresh;
$('search').oninput = (e) => { query = e.target.value; render(); };
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); refresh(); }
});

(async () => {
  state = await window.library.get();
  render();
  refresh(); // check for new games every time the app opens
  showUpdate(await window.library.update.get());
  showUpdate(await window.library.update.check()); // ...and for a new version of the app
})();
