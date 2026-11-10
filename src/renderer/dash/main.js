// The dashboard: which screen is showing, what the arrows and the A/B/X/Y
// commands mean on it, and the camera travel between screens.
//
// The library itself (which games there are, starting one, adding, updating
// the app) is app.js's business. It calls start() with the things the
// dashboard may ask for, and gets back the few things it may ask of the
// dashboard.
import { prefs, still, clamp } from './prefs.js';
import { cue, unlock } from './sound.js';
import { createGrid } from './grid.js';
import { createOrb } from './orb.js';
import { createChamber } from './chamber.js';
import { createRaster } from './raster.js';
import { createTravel } from './travel.js';
import { createCarousel, consoleName } from './carousel.js';
import { createInput } from './input.js';

export { consoleName };

// hooks: play(game, {reset, diagnose}) -> promise; failed(text) (a game did not
//        start and the "Starting" screen is no longer there to say so); remove(game); picture(game);
//        filter(delta) (another console); find(text) (the search field changed)
export function start(hooks) {
  const root = document.getElementById('dash');
  const $ = (selector) => root.querySelector(selector);
  const scene = $('.dn-scene');
  const home = $('.dn-home');
  const stage = $('.dn-stage');
  const library = $('.dn-library');
  const flight = $('.dn-flight');
  const items = [...root.querySelectorAll('.dn-item')];
  const views = Object.fromEntries([...root.querySelectorAll('[data-view]')].map((el) => [el.dataset.view, el]));
  const view = (name) => views[name];
  const art = $('.dn-art-fallback');
  const search = $('#search');
  const findBox = $('.dc-find');
  const filterButton = $('#filter');
  const gameScreen = $('.dc-game-screen');

  let page = 'home';
  let selected = 0;
  let info = { total: 0, filter: 'all', consoles: [], query: '' };
  let afterArrive = null;

  for (const img of root.querySelectorAll('img')) img.decode?.().catch(() => {});

  createGrid($('.dn-grid'), home);
  const orb = createOrb({ root, home, canvas: $('.dn-art-canvas'), image: art });
  createChamber({ root, library, canvas: $('.dc-chamber-canvas') });

  // ----- Games -----
  const carousel = createCarousel({
    root,
    library,
    onCue: (name) => cue(name),
    onFocus: showFocused,
    onOpen: startGame,
  });

  function showFocused(game) {
    $('.dc-info-title').textContent = game ? game.title : '';
    const meta = $('.dc-info-meta');
    meta.replaceChildren();
    if (game) {
      const parts = [consoleName(game.core)];
      if (game.version) parts.push(`v${game.version}`);
      if (game.players > 1) parts.push(`${game.players}P`);
      if (game.status) parts.push(game.status);
      meta.append(parts.join(' · '));
      if (game.local) {
        const local = document.createElement('span');
        local.className = 'local';
        local.textContent = 'On this Mac';
        meta.append(' · ', local);
      }
    }
    $('.dc-info-desc').textContent = (game && game.description) || '';
    // X and Y are for games that were added from a file.
    $('.dn-game-remove').hidden = !(game && game.local);
    $('.dn-game-picture').hidden = !(game && game.local);
    $('.dn-game-select').disabled = !game;
  }

  // The "Starting…" screen. It goes away by itself a little after the game
  // has opened in its own window, or with B; a game that could not be started
  // says why and waits for B.
  let leaveTimer = 0;
  function startGame(game, mods, current) {
    clearTimeout(leaveTimer);
    cue('select');
    const picture = carousel.focusedArt();
    $('.dc-game-art').style.backgroundImage = picture && picture.naturalWidth ? `url("${picture.src}")` : 'none';
    gameScreen.classList.remove('error');
    $('.dc-game-eyebrow').textContent = 'STARTING';
    $('.dc-game-title').textContent = game.title;
    $('.dc-game-text').textContent = `Starting ${game.title}…`;
    const began = performance.now();
    Promise.resolve()
      .then(() => hooks.play(game, mods))
      .then(
        () => {
          if (!current()) return;
          $('.dc-game-text').textContent = `${game.title} opens in its own window.`;
          // (long enough to see the zoom and read the line)
          leaveTimer = setTimeout(() => current() && carousel.close(true), Math.max(2600, 3400 - (performance.now() - began)));
        },
        (err) => {
          const text = `${game.title} couldn't be started: ${(err && err.message) || err}`;
          // A game that did not start always says so. When its "Starting" screen
          // is gone (B was pressed, the library was redrawn), in a message.
          if (!current()) return hooks.failed(text);
          gameScreen.classList.add('error');
          $('.dc-game-eyebrow').textContent = 'NOT STARTED';
          $('.dc-game-text').textContent = text;
        }
      );
  }

  // ----- the list screens (Load ROM, Friends, Settings): arrows move between their rows -----
  const rows = (name = page) => [...view(name).querySelectorAll('[data-nav]')].filter((el) => el.offsetParent !== null);
  const current = {}; // per screen: the row the arrows are on
  function setRow(el) {
    for (const other of view(page).querySelectorAll('[data-current]')) delete other.dataset.current;
    if (!el) return;
    current[page] = el;
    (el.closest('.dn-row') || el).dataset.current = '';
    if (!el.disabled) el.focus({ preventScroll: true });
    (el.closest('.dn-setting') || el).scrollIntoView({ block: 'nearest' });
  }
  function moveRow(delta) {
    const list = rows();
    if (!list.length) return;
    const at = list.indexOf(current[page]);
    let i = clamp((at < 0 ? 0 : at) + (at < 0 ? 0 : delta), 0, list.length - 1);
    while (list[i].disabled && list[i + delta]) i += delta; // a switched-off row (Volume with the sound off) is stepped over
    if (list[i].disabled && at >= 0) i = at;
    const next = list[i];
    if (next !== current[page]) cue('focus');
    setRow(next);
  }
  // A row that was busy (the Update button while it checks) takes the focus back when it is done.
  new MutationObserver((changes) => {
    for (const { target } of changes) {
      if (!target.disabled && target === current[page] && !root.dataset.transitioning && (document.activeElement === document.body || !document.activeElement)) target.focus({ preventScroll: true });
    }
  }).observe(root, { attributes: true, attributeFilter: ['disabled'], subtree: true });
  root.addEventListener('focusin', (e) => {
    if (page !== 'home' && page !== 'games' && e.target.matches && e.target.matches('[data-nav]') && view(page).contains(e.target) && e.target !== current[page]) setRow(e.target);
  });

  // ----- going from screen to screen -----
  function focusPage() {
    if (page === 'home') items[selected].focus({ preventScroll: true });
    else if (page === 'games') {
      if (carousel.count) carousel.focus();
      else $('#empty').focus({ preventScroll: true }); // (it says what to do; A has nothing to press here)
    } else {
      const list = rows();
      if (list.length) setRow(list.includes(current[page]) ? current[page] : list[0]);
      else view(page).querySelector('.dn-back').focus({ preventScroll: true });
    }
  }

  function arrive(name) {
    page = name;
    root.dataset.page = name;
    for (const el of Object.values(views)) {
      el.hidden = el !== view(name);
      el.inert = el.hidden;
      el.style.transform = el.style.opacity = el.style.zIndex = el.style.transformOrigin = el.style.visibility = '';
    }
    focusPage();
    const then = afterArrive;
    afterArrive = null;
    if (then) then();
  }

  const travel = createTravel({ root, scene, stage, flight, home, art, raster: createRaster({ scene, stage, grid: $('.dn-grid'), core: $('.dn-core'), art, items, prompt: $('.dn-select'), version: $('#home-version') }), view, focusedArt: () => carousel.focusedArt(), onArrive: arrive });

  function go(next, back = false) {
    if (travel.busy || next === page || !view(next)) return;
    if (page === 'games') {
      clearTimeout(leaveTimer);
      if (carousel.screen !== 'home') carousel.close(true);
    }
    cue(back ? 'back' : 'select');
    travel.start(page, next, back);
  }

  function choose(i, gesture = false) {
    if (travel.busy) return;
    i = clamp(i, 0, items.length - 1);
    if (i === selected) return;
    selected = i;
    items.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
    orb.react(items[i]);
    if (gesture) unlock();
    cue('focus');
  }

  // ----- the commands -----
  function back() {
    if (travel.busy) {
      if (travel.reverse()) cue('back');
      return;
    }
    if (page === 'games' && carousel.screen !== 'home') {
      clearTimeout(leaveTimer);
      carousel.close();
      return;
    }
    if (page !== 'home') go('home', true);
  }

  function select(mods) {
    if (travel.busy) return;
    if (page === 'home') go(items[selected].dataset.page);
    else if (page === 'games') carousel.open(mods);
    else {
      const row = current[page] && rows().includes(current[page]) ? current[page] : rows()[0];
      if (!row || row.disabled) return;
      if (row.type === 'range') return; // (left and right change it)
      cue('select');
      row.click();
    }
  }

  function direction(key) {
    if (travel.busy) return;
    const forward = key === 'ArrowDown' || key === 'ArrowRight';
    if (page === 'home') {
      choose(selected + (forward ? 1 : -1), true);
      items[selected].focus({ preventScroll: true });
    } else if (page === 'games') {
      if (carousel.screen !== 'home') return;
      if (key === 'ArrowLeft' || key === 'ArrowRight') carousel.step(forward ? 1 : -1);
      else hooks.filter(forward ? 1 : -1);
    } else if (key === 'ArrowUp' || key === 'ArrowDown') moveRow(forward ? 1 : -1);
    else {
      const row = current[page];
      if (row && !row.disabled && row.type === 'range' && rows().includes(row)) {
        const next = clamp(Number(row.value) + (forward ? 1 : -1) * Number(row.step || 1), Number(row.min), Number(row.max));
        if (next !== Number(row.value)) {
          row.value = String(next);
          row.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }
  }

  const onRail = () => page === 'games' && !travel.busy && carousel.screen === 'home';
  function remove() {
    if (onRail() && carousel.game && carousel.game.local) hooks.remove(carousel.game);
  }
  function picture() {
    if (onRail() && carousel.game && carousel.game.local) hooks.picture(carousel.game);
  }
  function find() {
    if (!onRail() || !info.total) return;
    findBox.hidden = false;
    search.focus();
    search.select();
  }
  function jump(key) {
    if (!onRail() || !carousel.count) return;
    if (key === 'Home') carousel.go(0, true);
    else if (key === 'End') carousel.go(carousel.count - 1, true);
    else carousel.step(key === 'PageDown' ? 5 : -5);
  }

  createInput({ direction, select, back, remove, picture, find, jump });

  // ----- clicks -----
  // Only a pointer that really moved chooses a menu item. (When the home
  // screen comes back, the browser tells whatever lies under a resting
  // pointer that the pointer has "entered" it; that is not a choice.)
  const pointerAt = { x: NaN, y: NaN };
  window.addEventListener('pointermove', (e) => {
    pointerAt.x = e.screenX;
    pointerAt.y = e.screenY;
  });
  items.forEach((b, i) => {
    b.addEventListener('pointermove', (e) => {
      if (e.screenX === pointerAt.x && e.screenY === pointerAt.y) return;
      choose(i);
    });
    b.addEventListener('focus', () => choose(i));
    b.addEventListener('click', () => {
      choose(i);
      select({});
    });
  });
  $('.dn-select').addEventListener('click', () => select({}));
  for (const b of root.querySelectorAll('.dn-back, .dn-home-back')) b.addEventListener('click', back);
  $('.dn-game-select').addEventListener('click', (e) => select({ reset: e.altKey, diagnose: e.shiftKey }));
  // (the keys stay with the rail after a click on one of its prompts)
  $('.dn-game-remove').addEventListener('click', () => {
    focusPage();
    remove();
  });
  $('.dn-game-picture').addEventListener('click', () => {
    focusPage();
    picture();
  });
  // After a click on a message's button (Dismiss, say) the keys go back to the screen.
  $('.dn-messages').addEventListener('click', () => setTimeout(() => !travel.busy && focusPage(), 0));
  // A click on empty space gives the keys back to the screen.
  root.addEventListener('pointerdown', (e) => {
    if (travel.busy || (e.target.closest && e.target.closest('button, input, a, .dn-notice'))) return;
    if (page === 'home' || page === 'games') setTimeout(focusPage, 0);
  });

  // ----- the search field and the console filter on Games -----
  search.addEventListener('input', () => hooks.find(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      search.value = '';
      hooks.find('');
      findBox.hidden = true;
      focusPage();
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (!search.value) findBox.hidden = true;
      focusPage();
    }
  });
  search.addEventListener('blur', () => {
    if (!search.value) findBox.hidden = true;
  });
  filterButton.addEventListener('click', () => {
    hooks.filter(1);
    focusPage();
  });

  // ----- Settings: sound, volume, motion -----
  const soundButton = $('#sound');
  const motionButton = $('#motion');
  const volume = $('#volume');
  function showPrefs() {
    soundButton.setAttribute('aria-pressed', String(prefs.sound));
    soundButton.querySelector('span').textContent = prefs.sound ? 'On' : 'Off';
    motionButton.setAttribute('aria-pressed', String(prefs.motion));
    motionButton.querySelector('span').textContent = prefs.motion ? 'On' : 'Off';
    volume.value = String(prefs.volume);
    volume.setAttribute('aria-valuetext', `${Math.round((prefs.volume / 60) * 100)} percent`);
    volume.disabled = !prefs.sound;
    root.classList.toggle('dn-still', still());
    if (still()) {
      travel.settle();
      carousel.settle();
    }
    orb.update();
  }
  soundButton.addEventListener('click', () => {
    prefs.set('sound', !prefs.sound);
    if (prefs.sound) cue('select');
  });
  motionButton.addEventListener('click', () => prefs.set('motion', !prefs.motion));
  volume.addEventListener('input', () => {
    prefs.set('volume', Number(volume.value));
    cue('focus');
  });
  prefs.onChange(showPrefs);
  showPrefs();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) travel.settle();
  });

  // On a big screen the plain text (Settings, messages) grows with the window,
  // the way the home screen and the boxes do by themselves.
  const fit = () => {
    const r = scene.getBoundingClientRect();
    if (r.width) root.style.setProperty('--zoom', clamp(Math.min(r.width / 1280, r.height / 720), 1, 2.5).toFixed(3));
  };
  new ResizeObserver(fit).observe(scene);
  fit();

  for (const el of Object.values(views)) el.inert = el.hidden;
  root.dataset.ready = '';
  focusPage();

  return {
    get page() {
      return page;
    },
    get game() {
      return carousel.game;
    },
    find,
    // The library as it is now. `about` says what is being shown:
    // { total, filter, consoles, query }.
    setGames(games, about, focusId) {
      info = about;
      // (it stays when its game is still there; otherwise what it said goes into a message)
      const lost = carousel.screen !== 'home' && gameScreen.classList.contains('error') ? $('.dc-game-text').textContent : '';
      carousel.setGames(games, focusId);
      if (lost && carousel.screen === 'home') {
        gameScreen.classList.remove('error');
        hooks.failed(lost);
      }
      const empty = $('#empty');
      empty.hidden = games.length > 0;
      if (!games.length) {
        empty.querySelector('h2').textContent = about.total ? 'No games match' : 'No games yet';
        $('#empty-text').textContent = about.total
          ? 'Nothing fits what you are looking for. Press Escape in the search field to see every game again.'
          : 'Add one of your own with Load ROM, or drag a game file onto this window.';
      }
      // The console filter shows only when there is something to choose between.
      filterButton.hidden = about.consoles.length < 2;
      filterButton.classList.toggle('on', about.filter !== 'all');
      filterButton.textContent = about.filter === 'all' ? `All consoles · ${about.total}` : `${about.filter} · ${games.length} of ${about.total}`;
      if (!about.total) findBox.hidden = true;
      // (the box that had the focus may be gone)
      if (page === 'games' && !travel.busy && (!document.activeElement || document.activeElement === document.body)) focusPage();
    },
    // Shows the game `id` in front on the Games screen, travelling there if need be.
    showGame(id, games, about) {
      this.setGames(games, about, id);
      if (page === 'games') focusPage();
      else if (travel.busy) afterArrive = () => page !== 'games' && go('games');
      else go('games');
    },
  };
}
