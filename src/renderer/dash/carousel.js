// The Games screen: the library's games as boxes on a turning rail. The one
// in front is the one that A starts.
import { still, awake } from './prefs.js';

const CONSOLES = {
  nes: 'NES', fceumm: 'NES',
  snes: 'SNES', snes9x: 'SNES',
  gba: 'GBA', mgba: 'GBA',
  gb: 'Game Boy', gbc: 'Game Boy Color', gambatte: 'Game Boy',
  segaMD: 'Genesis', genesis_plus_gx: 'Genesis',
  n64: 'N64', mupen64plus_next: 'N64',
};
export const consoleName = (core) => CONSOLES[core] || String(core || '').toUpperCase();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// A box without a picture: the DL mark, the game's name, its console.
function placeholder(game) {
  const box = el('span', 'dc-box dc-placeholder');
  box.append(el('small', '', 'DEVIOUS LICKS GAMES'), el('span', 'dc-monogram', 'DL'), el('b', '', game.title), el('small', '', consoleName(game.core)));
  return box;
}

// A box with the game's picture on its face. The box takes the picture's
// shape (within reason), so box art of any proportions is shown whole and
// undistorted; what little may be left over shows a blurred copy of it.
function pictured(game) {
  const box = el('span', 'dc-box');
  const backdrop = el('img', 'dc-backdrop');
  const img = el('img', 'dc-art');
  backdrop.alt = img.alt = '';
  backdrop.draggable = img.draggable = false;
  const shape = () => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    box.style.setProperty('--ar', String(Math.max(0.56, Math.min(1.6, img.naturalWidth / img.naturalHeight)).toFixed(4)));
    box.classList.toggle('smooth', img.naturalWidth > 480); // a photo or a painting, not pixel art
  };
  img.addEventListener('load', shape);
  img.addEventListener('error', () => box.replaceWith(placeholder(game)));
  img.src = backdrop.src = game.cover;
  if (img.complete) shape();
  box.append(backdrop, img);
  return box;
}

export function createCarousel({ root, library, onFocus, onOpen, onCue }) {
  const rail = library.querySelector('.dc-rail');
  const announcement = library.querySelector('.dc-announcement');
  const gameScreen = library.querySelector('.dc-game-screen');
  let games = [];
  let covers = [];
  let index = 0;
  let position = 0;
  let target = 0;
  let velocity = 0;
  let frame = 0;
  let last = 0;
  let spacing = 280;
  let drag = null;
  let suppressClick = false;
  let wheelSum = 0;
  let lastWheel = -1000;
  let view = 'home'; // home | launching | game | returning
  let launchAnimation = null;
  let launchToken = 0;
  let landing = null; // what ends the zoom that is running (out to the "Starting" screen, or back from it)

  const count = () => games.length;
  const wrap = (n) => ((n % count()) + count()) % count();
  // How far cover n is from the front, going the short way round.
  const distance = (n) => (count() ? ((((n + count() / 2) % count()) + count()) % count()) - count() / 2 : 0);
  const busy = () => view !== 'home' || Boolean(root.dataset.transitioning);

  function draw(always = false) {
    if (view !== 'home' && !always) return;
    covers.forEach((b, i) => {
      const d = distance(i - position);
      const a = Math.abs(d);
      // Five boxes are in sight; with more games than that the rest wait out of view.
      const opacity = a <= 2.5 ? Math.max(0.05, 1 - a * 0.2 - Math.max(0, (a - 2.15) / 0.35) * 0.4) : Math.max(0, 0.1 - (a - 2.5) * 0.25);
      if (opacity <= 0) {
        b.style.display = 'none';
        return;
      }
      b.style.display = '';
      b.style.transform = `translate(-50%,-50%) translate3d(${(d * spacing).toFixed(2)}px,${(a * 12).toFixed(2)}px,${(-a * 260).toFixed(2)}px) rotateY(${(-Math.max(-1.65, Math.min(1.65, d)) * 37).toFixed(2)}deg)`;
      b.style.zIndex = String(100 - Math.round(a * 20));
      b.style.opacity = String(opacity);
      b.style.filter = `brightness(${(1 - Math.min(a, 2) * 0.2).toFixed(3)})`;
    });
  }

  function mark() {
    covers.forEach((b, i) => {
      const game = games[i];
      const on = i === index;
      b.setAttribute('aria-pressed', String(on));
      b.tabIndex = on ? 0 : -1;
      b.setAttribute('aria-label', `${game.title}, ${consoleName(game.core)}${game.local ? ', on this Mac' : ''}${game.cover ? '' : ', no picture yet'}${on ? ', selected' : ''}`);
    });
  }

  function selected(next, direction, quiet) {
    next = wrap(next);
    if (next === index) return;
    index = next;
    mark();
    announcement.textContent = games[index].title;
    onFocus(games[index], index);
    if (!quiet) onCue('focus', direction);
  }

  function tick(now) {
    frame = 0;
    if (!awake() || library.hidden) {
      position = target;
      velocity = 0;
      draw();
      return;
    }
    const dt = Math.min(last ? (now - last) / 1000 : 1 / 60, 0.05);
    last = now;
    const steps = Math.ceil(dt * 120);
    const h = dt / steps;
    for (let j = 0; j < steps; j++) {
      velocity += ((target - position) * 105 - velocity * 20) * h;
      position += velocity * h;
    }
    if (Math.abs(target - position) < 0.0005 && Math.abs(velocity) < 0.005) {
      position = target;
      velocity = 0;
      last = 0;
      draw();
      return;
    }
    draw();
    frame = requestAnimationFrame(tick);
  }

  function animate() {
    if (still()) {
      cancelAnimationFrame(frame);
      frame = 0;
      position = target;
      velocity = 0;
      draw();
      return;
    }
    if (!frame) {
      last = 0;
      frame = requestAnimationFrame(tick);
    }
  }

  function go(next, focus = false) {
    if (busy() || !count()) return;
    const delta = distance(wrap(next) - index);
    if (delta === 0) return;
    target += delta;
    selected(next, Math.sign(delta));
    animate();
    if (focus) covers[index].focus({ preventScroll: true });
  }

  // ----- starting a game -----
  function open(mods) {
    if (busy() || !count()) return;
    view = 'launching';
    const token = ++launchToken;
    cancelAnimationFrame(frame);
    frame = 0;
    velocity = 0;
    drag = null;
    position = target;
    const game = games[index];
    const cover = covers[index];
    library.dataset.screen = 'launching';
    rail.inert = true;
    cover.classList.add('is-launching');
    announcement.textContent = `Starting ${game.title}`;
    const complete = () => {
      if (token !== launchToken) return;
      view = 'game';
      library.dataset.screen = 'game';
      gameScreen.hidden = false;
    };
    landing = complete;
    onOpen(game, mods || {}, () => token === launchToken);
    if (still() || !cover.animate) return complete();
    launchAnimation = cover.animate(
      [
        { transform: cover.style.transform, opacity: 1, filter: 'brightness(1)' },
        { offset: 0.72, transform: 'translate(-50%,-50%) translate3d(0,0,560px) rotateY(0deg)', opacity: 1, filter: 'brightness(1.12)' },
        { transform: 'translate(-50%,-50%) translate3d(0,0,820px) rotateY(0deg)', opacity: 0, filter: 'brightness(1.15)' },
      ],
      { duration: 720, easing: 'cubic-bezier(.32,.04,.24,1)', fill: 'forwards' }
    );
    launchAnimation.finished.then(complete).catch(() => {});
  }

  // Back from the "Starting…" screen to the rail. With `quiet`, no sound (the game took over).
  function close(quiet = false) {
    if (view === 'home' || view === 'returning') return;
    const wasLaunching = view === 'launching';
    ++launchToken;
    if (launchAnimation) launchAnimation.cancel();
    launchAnimation = null;
    if (!quiet) onCue('back');
    const cover = covers[index];
    position = target;
    velocity = 0;
    const finish = () => {
      view = 'home';
      library.dataset.screen = 'home';
      gameScreen.hidden = true;
      rail.inert = false;
      covers.forEach((b) => b.classList.remove('is-launching'));
      draw();
      if (cover && !library.hidden && !root.dataset.transitioning) cover.focus({ preventScroll: true });
      if (games[index]) announcement.textContent = `Back to ${games[index].title}`;
    };
    if (wasLaunching || still() || !cover || !cover.animate || !awake()) return finish();
    landing = finish;
    view = 'returning';
    library.dataset.screen = 'returning';
    gameScreen.hidden = true;
    rail.inert = true;
    cover.classList.add('is-launching');
    launchAnimation = cover.animate(
      [{ transform: 'translate(-50%,-50%) translate3d(0,0,560px) rotateY(0deg)', opacity: 0 }, { offset: 0.24, opacity: 1 }, { transform: cover.style.transform, opacity: 1 }],
      { duration: 520, easing: 'cubic-bezier(.16,.7,.24,1)', fill: 'forwards' }
    );
    launchAnimation.finished
      .then(() => {
        if (launchAnimation) launchAnimation.cancel();
        launchAnimation = null;
        finish();
      })
      .catch(() => {});
  }

  // ----- the library changed -----
  // Draws the rail again for `list`. The game in front stays in front when it
  // is still there (or `focusId`, when given); boxes that did not change are kept.
  function setGames(list, focusId) {
    const keep = focusId || (games[index] && games[index].id);
    const before = index;
    const old = new Map(covers.map((b, i) => [b.dataset.key, b]));
    // While a game is starting, its "Starting" screen stays through a redraw
    // (a refresh that ends just then must not take away what it says), as
    // long as the game is still there and no other game is asked to the front.
    const starting = view !== 'home' && !focusId ? games[index] : null;
    const stays = Boolean(starting && list.some((g) => g.id === starting.id));
    const startingCover = stays ? covers[index] : null;
    if (view !== 'home' && !stays) {
      ++launchToken;
      if (launchAnimation) launchAnimation.cancel();
      launchAnimation = null;
      view = 'home';
      library.dataset.screen = 'home';
      gameScreen.hidden = true;
      rail.inert = false;
    }
    const hadFocus = rail.contains(document.activeElement);
    games = list.slice();
    covers = games.map((game) => {
      const key = JSON.stringify([game.id, game.title, game.core, game.cover || '']);
      let b = old.get(key);
      if (b) old.delete(key);
      else {
        b = el('button', 'dc-cover');
        b.type = 'button';
        b.dataset.key = key;
        b.append(game.cover ? pictured(game) : placeholder(game));
      }
      b.dataset.id = game.id;
      if (game.local) b.dataset.local = '';
      else delete b.dataset.local;
      b.classList.remove('is-launching');
      b.title = game.description ? `${game.title}: ${game.description}` : game.title;
      return b;
    });
    for (const b of old.values()) b.remove();
    covers.forEach((b, i) => {
      b.onclick = (e) => {
        if (suppressClick || view !== 'home') return;
        if (i === index) open({ reset: e.altKey, diagnose: e.shiftKey });
        else go(i, true);
      };
      b.onfocus = () => {
        if (!drag) go(i);
      };
      if (rail.children[i + 1] !== b) rail.insertBefore(b, rail.children[i + 1] || null); // (the floor is the rail's first child)
    });
    const found = games.findIndex((g) => g.id === keep);
    index = found >= 0 ? found : Math.max(0, Math.min(before, games.length - 1));
    position = target = index;
    velocity = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    mark();
    draw(true);
    if (stays) {
      // (its box may be a new one: the zoom that ran on the old one is over)
      if (covers[index] !== startingCover && (view === 'launching' || view === 'returning')) {
        if (launchAnimation) launchAnimation.cancel();
        launchAnimation = null;
        landing();
      }
      if (view !== 'home') covers[index].classList.add('is-launching');
    }
    if (games[index] && view === 'home') announcement.textContent = games[index].title;
    onFocus(games[index] || null, index);
    if (hadFocus && games[index] && !library.hidden && view === 'home') covers[index].focus({ preventScroll: true });
    resize();
  }

  // ----- mouse and trackpad -----
  rail.addEventListener(
    'wheel',
    (e) => {
      if (busy()) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 2) return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastWheel < 170) return;
      wheelSum += delta * (e.deltaMode === 1 ? 16 : 1);
      if (Math.abs(wheelSum) >= 42) {
        go(index + Math.sign(wheelSum));
        wheelSum = 0;
        lastWheel = now;
      }
    },
    { passive: false }
  );
  rail.addEventListener('pointerdown', (e) => {
    if (busy() || e.button !== 0 || count() < 2) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: position, lastX: e.clientX, lastTime: performance.now(), speed: 0, started: false };
    suppressClick = false;
  });
  rail.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!e.buttons) return release(e, true); // the button came up somewhere the rail did not hear of
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.started) {
      if (Math.abs(dx) < 9 || Math.abs(dx) < Math.abs(dy)) return;
      drag.started = true;
      if (rail.setPointerCapture) rail.setPointerCapture(e.pointerId);
      cancelAnimationFrame(frame);
      frame = 0;
      velocity = 0;
    }
    suppressClick = true;
    const now = performance.now();
    const dt = Math.max(0.008, (now - drag.lastTime) / 1000);
    drag.speed = drag.speed * 0.55 + ((drag.lastX - e.clientX) / spacing / dt) * 0.45;
    drag.lastTime = now;
    drag.lastX = e.clientX;
    position = drag.start - dx / spacing;
    target = Math.round(position);
    selected(target, Math.sign(drag.lastX - drag.x) * -1 || 1);
    draw();
  });
  function release(e, cancelled = false) {
    if (!drag || drag.id !== e.pointerId) return;
    const was = drag;
    drag = null;
    if (!was.started) return;
    if (rail.releasePointerCapture) rail.releasePointerCapture(e.pointerId);
    const flick = cancelled ? 0 : Math.max(-0.65, Math.min(0.65, was.speed * 0.12));
    target = Math.round(position + flick);
    selected(target, Math.sign(flick) || Math.sign(target - position) || 1);
    velocity = cancelled ? 0 : Math.max(-5, Math.min(5, was.speed));
    animate();
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 0);
  }
  // (on the window: a press on a box may be let go anywhere)
  window.addEventListener('pointerup', (e) => release(e));
  window.addEventListener('pointercancel', (e) => release(e, true));

  function resize() {
    if (!rail.clientWidth) return;
    // As approved at 1280 wide (288); on a big screen the boxes are bigger, so they stand further apart.
    const box = covers[0] ? covers[0].offsetWidth : 0;
    spacing = Math.max(Math.min(288, Math.max(168, rail.clientWidth * 0.29)), box * 0.643);
    draw();
  }
  new ResizeObserver(resize).observe(rail);

  // Nothing moves while nobody is looking.
  const rest = () => {
    if (awake()) return;
    cancelAnimationFrame(frame);
    frame = 0;
    position = target;
    velocity = 0;
    draw();
  };
  document.addEventListener('visibilitychange', rest);
  window.addEventListener('blur', rest);

  return {
    setGames,
    go,
    step: (delta) => go(index + delta, true),
    open,
    close,
    settle: animate,
    get game() {
      return games[index] || null;
    },
    get count() {
      return count();
    },
    get screen() {
      return view;
    },
    focus() {
      if (covers[index]) covers[index].focus({ preventScroll: true });
    },
    focusedArt() {
      return covers[index] ? covers[index].querySelector('.dc-art') : null;
    },
  };
}
