#!/usr/bin/env node
// Walks through the library window (the dashboard) in a plain Chromium, with
// a stand-in for the app behind it, and fails on anything that is off: a
// screen that does not come up, a command that does not reach the app, a
// page error, an error in the console.
//
//   npm run check:dashboard                  (needs Playwright: npm i -g playwright, or npx)
//   node scripts/check-dashboard.js --shots <folder>    also saves pictures of every screen
//   node scripts/check-dashboard.js --only Settings     just the scenes with that in their title
//
// No Electron is involved: the page is served from src/renderer over
// http://127.0.0.1 and window.library is a fake (see fakeLibrary below).
const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('This check needs Playwright (npm install -g playwright, then: npx playwright install chromium).');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const VERSION = require('../package.json').version;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.txt': 'text/plain' };
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Runs in the page before anything else: the app's side, faked. What the page
// asked for is kept in window.__calls; window.__fake steers the answers.
function fakeLibrary({ games, version, options }) {
  // A picture drawn here (no picture files are needed, or shipped, for this check).
  const picture = (w, h, hue, label) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${hue} 80% 55%)`);
    g.addColorStop(1, `hsl(${(hue + 70) % 360} 80% 22%)`);
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#ffffffcc';
    for (let i = 0; i < 9; i++) x.fillRect(((i * 37) % 90) * w / 100, ((i * 53) % 85) * h / 100, w * 0.06, w * 0.06);
    x.fillStyle = '#fff';
    x.font = `bold ${Math.round(w / 8)}px sans-serif`;
    x.textAlign = 'center';
    x.fillText(label, w / 2, h / 2);
    return c.toDataURL('image/png');
  };
  const calls = [];
  const fake = { games: null, playError: null, playDelay: 0, refreshDelay: 0, refreshFailed: [], getError: null, nextUpdate: null, options };
  const wait = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : null);
  window.__calls = calls;
  window.__fake = fake;
  window.__picture = picture;
  const build = () => games.map((g) => ({ description: '', version: '', players: 1, status: null, local: false, ...g, cover: g.art ? picture(g.art[0], g.art[1], g.art[2], g.title.split(' ')[0]) : null, art: undefined }));
  const view = () => {
    if (!fake.games) fake.games = build();
    return { source: 'the test catalog', syncedAt: '2026-11-10T08:00:00.000Z', studio: 'Devious Licks', games: fake.games };
  };
  let update = { phase: 'none', version, installed: version };
  let onState = () => {};
  fake.setUpdate = (next) => {
    update = { version, installed: version, ...next };
    onState(update);
  };
  window.library = {
    get: async () => {
      calls.push(['get']);
      if (fake.getError) throw new Error(fake.getError);
      return view();
    },
    refresh: async () => {
      calls.push(['refresh']);
      await wait(fake.refreshDelay);
      return { ...view(), summary: { added: [], updated: [], removed: [], failed: fake.refreshFailed } };
    },
    play: async (id, opts) => {
      calls.push(['play', id, opts]);
      await wait(fake.playDelay);
      if (fake.playError) throw new Error(fake.playError);
    },
    addLocal: async (files) => {
      const names = files ? [...files].map((f) => f.name) : null;
      calls.push(['addLocal', names]);
      const added = [];
      const skipped = [];
      for (const name of names || ['Picked Game.z64']) {
        if (!/\.(z64|n64|v64|nes|sfc|smc|gb|gbc|gba|md|gen|smd)$/i.test(name)) {
          skipped.push(`${name}: not a kind of game file this app can play`);
          continue;
        }
        const title = name.replace(/\.[^.]+$/, '');
        fake.games = [{ id: `local-${title.toLowerCase().replace(/\W+/g, '-')}`, title, core: 'n64', description: '', version: '', players: 1, status: null, cover: null, local: true }, ...view().games];
        added.push(title);
      }
      return { ...view(), added, skipped };
    },
    removeLocal: async (id) => {
      calls.push(['removeLocal', id]);
      fake.games = view().games.filter((g) => g.id !== id);
      return view();
    },
    setCover: async (id, file) => {
      calls.push(['setCover', id, file ? file.name : null]);
      fake.games = view().games.map((g) => (g.id === id ? { ...g, cover: picture(300, 420, 300, 'NEW') } : g));
      return { ...view(), message: `${view().games.find((g) => g.id === id).title} has its picture` };
    },
    onProgress: () => {},
    up: () => calls.push(['up']),
    update: {
      get: async () => update,
      check: async () => {
        calls.push(['update.check']);
        if (fake.nextUpdate) {
          update = { version, installed: version, ...fake.nextUpdate };
          fake.nextUpdate = null;
        }
        return update;
      },
      install: async () => {
        calls.push(['update.install']);
        update = { ...update, phase: 'ready' };
        return update;
      },
      restart: async () => {
        calls.push(['update.restart']);
        return false;
      },
      openPage: async () => {
        calls.push(['update.openPage']);
      },
      onState: (fn) => (onState = fn),
    },
  };
  // A controller that the check can press buttons on.
  if (options && options.gamepad) {
    const pad = { index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
  }
}

const CATALOG_3 = [
  { id: 'neon', title: 'Neon Outrun', core: 'n64', description: 'A race through the night.', version: '1.2', players: 2, status: 'new', art: [600, 840, 150] },
  { id: 'void', title: 'Void Runner', core: 'snes', local: true },
  { id: 'rift', title: 'Rift Breaker', core: 'gba', description: 'Break the rift.', art: [256, 224, 20] },
  { id: 'wide', title: 'Wide Load', core: 'segaMD', art: [900, 500, 210] },
  { id: 'mine', title: 'My Own Game', core: 'n64', local: true, art: [512, 720, 280] },
];
const LONG_TITLE = 'Legend of Zelda, The - Ocarina of Time (USA) (Rev 2)';
const CATALOG_30 = Array.from({ length: 30 }, (_, i) => ({
  id: `g${i + 1}`,
  title: `Game Number ${i + 1}`,
  core: ['n64', 'snes', 'gba', 'nes'][i % 4],
  description: `The description of game ${i + 1}.`,
  local: i % 7 === 3,
  art: i % 3 ? [400 + (i % 5) * 40, 560, (i * 37) % 360] : null,
}));

let failures = 0;
let checks = 0;
const problems = [];
function check(what, ok, detail) {
  checks++;
  if (ok) return;
  failures++;
  console.log(`  FAILED: ${what}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
}

(async () => {
  const started = Date.now();
  const { server, base } = await serve();
  const browser = await chromium.launch();

  // One window onto the dashboard. `allow`: console errors this scene expects.
  async function open({ games = CATALOG_3, width = 1280, height = 720, reducedMotion = 'no-preference', options = {}, allow = null, before = null } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
    const page = await context.newPage();
    page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error' || (allow && allow.test(m.text()))) return;
      problems.push(`console error: ${m.text()}`);
    });
    page.on('requestfailed', (r) => {
      if (!(allow && allow.test(r.url()))) problems.push(`request failed: ${r.url()}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !(allow && allow.test(r.url()))) problems.push(`${r.status()} for ${r.url()}`);
    });
    await page.addInitScript(fakeLibrary, { games, version: VERSION, options });
    if (before) await before(page);
    await page.goto(`${base}/index.html`);
    if (!options.broken) await page.waitForSelector('#dash[data-ready]');
    const at = (name) => page.waitForFunction((n) => document.getElementById('dash').dataset.page === n && !document.getElementById('dash').dataset.transitioning, name, { timeout: 5000 });
    const calls = (name) => page.evaluate((n) => window.__calls.filter((c) => c[0] === n), name);
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };
    const front = () => page.evaluate(() => {
      const b = document.querySelector('.dc-cover[aria-pressed=true]');
      return b ? b.dataset.id : null;
    });
    // From the home screen to the screen `name`, with the keys.
    const goTo = async (name) => {
      const i = ['games', 'rom', 'friends', 'settings'].indexOf(name);
      for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowUp');
      for (let k = 0; k < i; k++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await at(name);
    };
    const settled = () => page.waitForTimeout(700); // the rail's spring comes to rest
    return { page, context, at, calls, shot, front, goTo, settled };
  }

  const onlyAt = process.argv.indexOf('--only'); // --only <words>: just the scenes whose title has them
  const only = onlyAt > 0 ? process.argv[onlyAt + 1] : '';
  const scene = async (title, fn) => {
    if (only && !title.includes(only)) return;
    const before = problems.length;
    const failed = failures;
    try {
      await fn();
    } catch (err) {
      check(`${title} ran to its end`, false, String((err && err.stack) || err).split('\n').filter((l) => !/node_modules/.test(l)).slice(0, 4).join(' | '));
    }
    for (const p of problems.slice(before)) check(`${title}: nothing went wrong on the page`, false, p);
    console.log(`${failures === failed ? 'ok  ' : 'BAD '} ${title}`);
  };

  await scene('the window opens on the home screen and tells the app it is up', async () => {
    const w = await open();
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
    check('it asked for the library, then refreshed it', (await w.calls('get')).length === 1 && (await w.calls('refresh')).length === 1);
    const found = await w.page.evaluate(() => ({
      refresh: Boolean(document.getElementById('refresh')),
      update: document.getElementById('update').textContent.trim(),
      span: Boolean(document.querySelector('#update span')),
      version: document.getElementById('version').textContent,
      home: document.getElementById('home-version').textContent,
      notice: document.getElementById('notice').hidden,
      page: document.getElementById('dash').dataset.page,
      pressed: document.querySelector('.dn-item[aria-pressed=true] .dn-label').textContent,
      focus: document.activeElement.className,
      items: [...document.querySelectorAll('.dn-item .dn-label')].map((l) => l.textContent),
    }));
    check('the elements the app itself looks for are there from the start', found.refresh && found.span && found.update === 'Update' && found.version === `Version ${VERSION}` && found.notice, found);
    check('home: the menu, with Games chosen and focused', found.page === 'home' && found.pressed === 'GAMES' && /dn-item/.test(found.focus) && found.items.join() === 'GAMES,LOAD ROM,FRIENDS,SETTINGS', found);
    check('home: the version is shown', found.home === `Version ${VERSION}`, found.home);
    await w.page.waitForTimeout(500);
    await w.shot('01-home');
    await w.context.close();
  });

  await scene('home to each screen and back, with the camera travel', async () => {
    const w = await open();
    const titles = { rom: 'LOAD ROM', friends: 'FRIENDS', settings: 'SETTINGS' };
    for (const name of ['games', 'rom', 'friends', 'settings']) {
      const i = ['games', 'rom', 'friends', 'settings'].indexOf(name);
      for (let k = 0; k < 3; k++) await w.page.keyboard.press('ArrowUp');
      for (let k = 0; k < i; k++) await w.page.keyboard.press('ArrowDown');
      const t0 = Date.now();
      await w.page.keyboard.press('Enter');
      const mid = await w.page.evaluate(() => document.getElementById('dash').dataset.transitioning);
      check(`${name}: the camera sets off`, mid === 'open', mid);
      await w.at(name);
      const took = Date.now() - t0;
      check(`${name}: the travel takes about 1.1 seconds`, took > 950 && took < 2600, took);
      const seen = await w.page.evaluate((n) => {
        const view = document.querySelector(`[data-view="${n}"]`);
        return {
          visible: !view.hidden && !view.inert,
          others: [...document.querySelectorAll('[data-view]')].filter((v) => v !== view && !v.hidden).length,
          title: view.querySelector('.dn-panel-title') ? view.querySelector('.dn-panel-title').textContent : null,
          focus: document.activeElement ? document.activeElement.id || document.activeElement.className : null,
        };
      }, name);
      check(`${name}: the screen is showing, alone`, seen.visible && seen.others === 0 && (name === 'games' || seen.title === titles[name]), seen);
      check(`${name}: something on it has the focus`, Boolean(seen.focus) && seen.focus !== '', seen.focus);
      await w.page.waitForTimeout(250);
      await w.shot({ games: '02-games', rom: '05-load-rom', friends: '07-friends', settings: '08-settings' }[name]);
      if (name === 'friends') check('friends: it says plainly that there is no online play yet', /not available yet/.test(await w.page.textContent('[data-view=friends]')));
      const t1 = Date.now();
      await w.page.keyboard.press(name === 'rom' ? 'b' : 'Escape');
      check(`${name}: B sets off for home`, (await w.page.evaluate(() => document.getElementById('dash').dataset.transitioning)) === 'back');
      await w.at('home');
      check(`${name}: the way home takes about 1.08 seconds`, Date.now() - t1 > 950 && Date.now() - t1 < 2600, Date.now() - t1);
      const pressed = await w.page.evaluate(() => [...document.querySelectorAll('.dn-item')].findIndex((b) => b === document.activeElement && b.getAttribute('aria-pressed') === 'true'));
      check(`${name}: home again, on the item it left from`, pressed === i, pressed);
    }
    // B on the way out turns the camera around.
    await w.page.keyboard.press('Enter');
    await w.page.waitForTimeout(300);
    await w.page.keyboard.press('Escape');
    await w.at('home');
    check('B during the way out comes back home', (await w.page.evaluate(() => document.getElementById('dash').dataset.page)) === 'home');
    // The mouse: a click on a menu item, a click on B BACK.
    await w.page.click('.dn-item[data-page=friends]');
    await w.at('friends');
    await w.page.click('[data-view=friends] .dn-back');
    await w.at('home');
    await w.context.close();
  });

  await scene('travel pictures (for the eye)', async () => {
    if (!SHOTS) return;
    const w = await open();
    await w.page.keyboard.press('Enter');
    for (const ms of [200, 500, 800, 950]) {
      await w.page.waitForFunction((p) => Number(document.getElementById('dash').dataset.flightProgress || 2) >= p, ms / 1100, { timeout: 4000 }).catch(() => {});
      await w.shot(`20-travel-out-${ms}`);
    }
    await w.at('games');
    await w.page.keyboard.press('Escape');
    for (const ms of [100, 350, 600, 900]) {
      await w.page.waitForFunction((p) => Number(document.getElementById('dash').dataset.flightProgress || 2) >= p, ms / 1080, { timeout: 4000 }).catch(() => {});
      await w.shot(`21-travel-home-${ms}`);
    }
    await w.at('home');
    await w.context.close();
  });

  await scene('Games with no games at all', async () => {
    const w = await open({ games: [] });
    await w.goTo('games');
    const seen = await w.page.evaluate(() => ({ empty: !document.getElementById('empty').hidden, text: document.getElementById('empty').textContent, covers: document.querySelectorAll('.dc-cover').length, select: document.querySelector('.dn-game-select').disabled, x: document.querySelector('.dn-game-remove').hidden }));
    check('a friendly empty state that points to Load ROM', seen.empty && /Load ROM/.test(seen.text) && seen.covers === 0 && seen.select && seen.x, seen);
    for (const key of ['Enter', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'x', 'y', '/', 'End']) await w.page.keyboard.press(key);
    check('the keys do nothing there', (await w.calls('play')).length === 0 && (await w.page.evaluate(() => document.getElementById('dash').dataset.page + (document.getElementById('dash').dataset.transitioning || ''))) === 'games');
    await w.shot('04-games-empty');
    await w.page.keyboard.press('Escape');
    await w.at('home');
    await w.context.close();
  });

  await scene('Games with one game', async () => {
    const w = await open({ games: [CATALOG_3[0]] });
    await w.goTo('games');
    await w.page.keyboard.press('ArrowRight');
    await w.page.keyboard.press('ArrowLeft');
    check('the one game stays in front', (await w.front()) === 'neon');
    const info = await w.page.evaluate(() => ({ title: document.querySelector('.dc-info-title').textContent, meta: document.querySelector('.dc-info-meta').textContent, box: document.querySelector('.dc-cover .dc-art') !== null, x: document.querySelector('.dn-game-remove').hidden, y: document.querySelector('.dn-game-picture').hidden, filter: document.getElementById('filter').hidden }));
    check('its name, console, version, players and "new" are shown; no X or Y for a catalog game', info.title === 'Neon Outrun' && /N64 · v1\.2 · 2P · new/i.test(info.meta) && info.box && info.x && info.y && info.filter, info);
    await w.context.close();
  });

  await scene('Games: pictures of any shape, placeholders, starting a game', async () => {
    const w = await open();
    await w.goTo('games');
    await w.page.waitForFunction(() => [...document.querySelectorAll('.dc-art')].every((i) => i.complete && i.naturalWidth));
    await w.settled();
    const boxes = await w.page.evaluate(() => [...document.querySelectorAll('.dc-cover')].map((b) => {
      const img = b.querySelector('.dc-art');
      const box = b.querySelector('.dc-box').getBoundingClientRect();
      return { id: b.dataset.id, placeholder: Boolean(b.querySelector('.dc-placeholder')), text: b.querySelector('.dc-placeholder') ? b.querySelector('.dc-placeholder').textContent : '', natural: img ? img.naturalWidth / img.naturalHeight : 0, fit: img ? getComputedStyle(img).objectFit : '', w: box.width, h: box.height };
    }));
    const front = boxes.find((b) => b.id === 'neon');
    check('five games, five boxes', boxes.length === 5, boxes.length);
    check('a game without a picture gets the DL placeholder with its name and console', boxes.find((b) => b.id === 'void').placeholder && /DEVIOUS LICKS GAMES.*DL.*Void Runner.*SNES/.test(boxes.find((b) => b.id === 'void').text), boxes.find((b) => b.id === 'void'));
    check('a picture is shown whole and undistorted (the box takes its shape)', front.fit === 'contain' && Math.abs(front.w / front.h - front.natural) < 0.05, front);
    await w.shot('02-games');
    await w.page.keyboard.press('ArrowRight');
    await w.settled();
    check('right: the next game comes to the front', (await w.front()) === 'void');
    const prompts = await w.page.evaluate(() => ({ x: !document.querySelector('.dn-game-remove').hidden, y: !document.querySelector('.dn-game-picture').hidden, meta: document.querySelector('.dc-info-meta').textContent, focus: document.activeElement.dataset.id }));
    check('a game added from a file is marked "On this Mac" and offers X REMOVE and Y PICTURE', prompts.x && prompts.y && /On this Mac/.test(prompts.meta) && prompts.focus === 'void', prompts);
    await w.shot('03-games-placeholder');
    await w.page.keyboard.press('ArrowRight');
    await w.page.keyboard.press('ArrowRight');
    await w.settled();
    await w.shot('03-games-wide-picture');
    await w.page.keyboard.press('ArrowLeft');
    await w.page.keyboard.press('ArrowLeft');
    await w.page.keyboard.press('ArrowLeft');
    await w.settled();

    // A: start the game in front.
    await w.page.keyboard.press('Enter');
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'play'));
    check('A starts the game in front', JSON.stringify(await w.calls('play')) === JSON.stringify([['play', 'neon', { reset: false, diagnose: false }]]), await w.calls('play'));
    await w.page.waitForSelector('.dc-game-screen:not([hidden])');
    const starting = await w.page.evaluate(() => ({ title: document.querySelector('.dc-game-title').textContent, text: document.querySelector('.dc-game-text').textContent, screen: document.querySelector('.dn-library').dataset.screen }));
    check('a "Starting" screen with the game\'s name', starting.title === 'Neon Outrun' && /Neon Outrun/.test(starting.text) && starting.screen === 'game', starting);
    await w.shot('10-starting');
    await w.page.waitForFunction(() => document.querySelector('.dn-library').dataset.screen === 'home', null, { timeout: 7000 });
    check('...which gives way to the rail again by itself', (await w.front()) === 'neon' && (await w.page.evaluate(() => document.activeElement.dataset.id)) === 'neon');
    // Shift: with the recorder. Option-click: the built-in emulator.
    await w.page.keyboard.press('Shift+Enter');
    await w.page.waitForSelector('.dc-game-screen:not([hidden])');
    await w.page.keyboard.press('b');
    await w.page.waitForFunction(() => document.querySelector('.dn-library').dataset.screen === 'home');
    await w.page.click('.dc-cover[aria-pressed=true]', { modifiers: ['Alt'] });
    await w.page.waitForSelector('.dc-game-screen:not([hidden])');
    await w.page.click('.dn-home-back');
    await w.page.waitForFunction(() => document.querySelector('.dn-library').dataset.screen === 'home');
    const plays = (await w.calls('play')).map((c) => c[2]);
    check('Shift asks for the recorder, Option-click for the built-in emulator', plays[1].diagnose === true && plays[1].reset === false && plays[2].reset === true && plays[2].diagnose === false, plays);
    check('B on the "Starting" screen goes back to the rail, not home', (await w.page.evaluate(() => document.getElementById('dash').dataset.page)) === 'games');
    // A game that does not start says why, and waits.
    await w.page.evaluate(() => (window.__fake.playError = 'the game file is missing'));
    await w.page.click('.dn-game-select');
    await w.page.waitForSelector('.dc-game-screen.error:not([hidden])');
    const error = await w.page.textContent('.dc-game-text');
    check('a game that could not be started says why', /Neon Outrun couldn't be started: .*the game file is missing/.test(error), error);
    await w.shot('11-starting-failed');
    await w.page.waitForTimeout(3600);
    check('...and stays until B', (await w.page.evaluate(() => document.querySelector('.dn-library').dataset.screen)) === 'game');
    await w.page.keyboard.press('Escape');
    await w.page.waitForFunction(() => document.querySelector('.dn-library').dataset.screen === 'home');
    await w.context.close();
  });

  await scene('Games: X removes, Y gives a picture', async () => {
    const w = await open();
    await w.goTo('games');
    await w.page.keyboard.press('x');
    await w.page.keyboard.press('y');
    await w.page.keyboard.press('Delete');
    check('X and Y do nothing on a game from the catalog', (await w.calls('removeLocal')).length === 0 && (await w.calls('setCover')).length === 0);
    await w.page.keyboard.press('ArrowRight');
    await w.settled();
    await w.page.keyboard.press('y');
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'setCover'));
    check('Y asks the app for a picture for the game in front', JSON.stringify(await w.calls('setCover')) === JSON.stringify([['setCover', 'void', null]]), await w.calls('setCover'));
    await w.page.waitForSelector('.dc-cover[data-id=void] .dc-art');
    check('the box now shows the picture, and the game is still in front and focused', (await w.front()) === 'void' && (await w.page.evaluate(() => document.activeElement.dataset.id)) === 'void');
    await w.page.keyboard.press('p');
    await w.page.click('.dn-game-picture');
    await w.page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'setCover').length === 3);
    await w.page.keyboard.press('x');
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'removeLocal'));
    check('X asks the app to remove it', JSON.stringify(await w.calls('removeLocal')) === JSON.stringify([['removeLocal', 'void']]), await w.calls('removeLocal'));
    await w.page.waitForFunction(() => document.querySelectorAll('.dc-cover').length === 4);
    const after = await w.page.evaluate(() => ({ front: document.querySelector('.dc-cover[aria-pressed=true]').dataset.id, focus: document.activeElement.dataset.id, x: document.querySelector('.dn-game-remove').hidden }));
    check('the rail closes up around the gap, without a reload', after.front === 'rift' && after.focus === 'rift' && after.x, after);
    // The same from a controller-style click on the prompt, and with Backspace.
    await w.page.keyboard.press('End');
    await w.settled();
    check('End goes to the last game', (await w.front()) === 'mine');
    await w.page.click('.dn-game-remove');
    await w.page.waitForFunction(() => document.querySelectorAll('.dc-cover').length === 3);
    await w.context.close();
  });

  await scene('adding a game: the button on Load ROM, and files dropped on the window', async () => {
    const w = await open();
    await w.goTo('rom');
    check('Load ROM: the big button has the focus', (await w.page.evaluate(() => document.activeElement.id)) === 'add');
    await w.page.keyboard.press('Enter');
    await w.at('games');
    check('A on it asks the app for a file (the app shows the Mac\'s dialog)', JSON.stringify(await w.calls('addLocal')) === JSON.stringify([['addLocal', null]]), await w.calls('addLocal'));
    check('...and the new game is shown, in front, on the Games screen', (await w.front()) === 'local-picked-game' && (await w.page.evaluate(() => document.activeElement.dataset.id)) === 'local-picked-game', await w.front());
    check('the result is said too', /Added Picked Game/.test(await w.page.textContent('#add-result')) && /Added Picked Game/.test(await w.page.textContent('#toast')));
    await w.shot('06-added');

    // Real File objects, dropped on the window.
    const drop = (files, selector = '#dash') => w.page.evaluate(({ files, selector }) => {
      const data = new DataTransfer();
      for (const [name, type] of files) data.items.add(new File([new Uint8Array(4096)], name, { type }));
      const target = document.querySelector(selector);
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
      const zone = { shown: !document.getElementById('dropzone').hidden, text: document.getElementById('dropzone-text').textContent };
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      return { ...zone, hiddenAfter: document.getElementById('dropzone').hidden };
    }, { files, selector });

    await w.page.keyboard.press('Escape');
    await w.at('home');
    const zone = await drop([['Dropped One.z64', ''], ['notes.txt', 'text/plain']]);
    check('dragging a game file over the window says what a drop will do', zone.shown && /Drop a game file/.test(zone.text) && zone.hiddenAfter, zone);
    await w.page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'addLocal').length === 2);
    check('a game file dropped anywhere is handed to the app', JSON.stringify((await w.calls('addLocal'))[1]) === JSON.stringify(['addLocal', ['Dropped One.z64', 'notes.txt']]), (await w.calls('addLocal'))[1]);
    await w.at('games');
    check('...and its game is shown in front', (await w.front()) === 'local-dropped-one', await w.front());
    check('what was skipped is said', /notes\.txt/.test(await w.page.textContent('#toast')), await w.page.textContent('#toast'));

    // A picture dropped on the Games screen goes to the game in front, when that game is local.
    const pic = await drop([['box.png', 'image/png']], '.dc-rail');
    check('dragging a picture over a local game says whose picture it will be', pic.shown && /Dropped One/.test(pic.text), pic);
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'setCover'));
    check('a dropped picture becomes the picture of the game in front', JSON.stringify(await w.calls('setCover')) === JSON.stringify([['setCover', 'local-dropped-one', 'box.png']]), await w.calls('setCover'));
    await w.page.waitForSelector('.dc-cover[data-id=local-dropped-one] .dc-art');
    await w.page.keyboard.press('ArrowRight');
    await w.page.keyboard.press('ArrowRight');
    await w.settled();
    check('(a catalog game is in front now)', (await w.front()) === 'neon', await w.front());
    await drop([['box.png', 'image/png']], '.dc-rail');
    await w.page.waitForTimeout(200);
    check('a picture dropped on a catalog game is not taken, and the window says why', (await w.calls('setCover')).length === 1 && /On this Mac/.test(await w.page.textContent('#toast')), await w.page.textContent('#toast'));
    await w.context.close();
  });

  await scene('Games with thirty games: getting around, the console filter, the search', async () => {
    const w = await open({ games: CATALOG_30 });
    await w.goTo('games');
    await w.settled();
    const rail = await w.page.evaluate(() => ({ all: document.querySelectorAll('.dc-cover').length, inSight: [...document.querySelectorAll('.dc-cover')].filter((b) => b.style.display !== 'none').length, filter: document.getElementById('filter').textContent }));
    check('thirty boxes, five of them in sight', rail.all === 30 && rail.inSight === 5, rail);
    check('the filter says what is shown', /All consoles · 30/i.test(rail.filter), rail.filter);
    await w.shot('12-games-thirty');
    for (let i = 0; i < 3; i++) await w.page.keyboard.press('ArrowRight');
    check('right, three times: the fourth game', (await w.front()) === 'g4', await w.front());
    await w.page.keyboard.press('ArrowLeft');
    await w.page.keyboard.press('PageDown');
    check('Page Down: five on', (await w.front()) === 'g8', await w.front());
    await w.page.keyboard.press('End');
    check('End: the last', (await w.front()) === 'g30', await w.front());
    await w.page.keyboard.press('ArrowRight');
    check('...and round to the first', (await w.front()) === 'g1', await w.front());
    await w.page.keyboard.press('Home');
    // Down: one console at a time.
    await w.page.keyboard.press('ArrowDown');
    await w.settled();
    let seen = await w.page.evaluate(() => ({ all: document.querySelectorAll('.dc-cover').length, filter: document.getElementById('filter').textContent, meta: document.querySelector('.dc-info-meta').textContent }));
    check('Down shows one console only', seen.all < 30 && seen.all > 0 && / of 30/.test(seen.filter) && seen.meta.toUpperCase().startsWith(seen.filter.split(' · ')[0].toUpperCase()), seen);
    await w.shot('13-games-one-console');
    await w.page.keyboard.press('ArrowUp');
    check('Up shows them all again', (await w.page.evaluate(() => document.querySelectorAll('.dc-cover').length)) === 30);
    // The search field.
    await w.page.keyboard.press('/');
    check('/ opens the search field', (await w.page.evaluate(() => document.activeElement.id)) === 'search');
    await w.page.keyboard.type('number 2');
    seen = await w.page.evaluate(() => [...document.querySelectorAll('.dc-cover')].map((b) => b.dataset.id));
    check('typing narrows the rail (letters like A, B and X are just letters there)', seen.length === 11 && seen[0] === 'g2' && seen.includes('g20'), seen);
    check('nothing was started, removed or left', (await w.calls('play')).length === 0 && (await w.page.evaluate(() => document.getElementById('dash').dataset.page)) === 'games');
    await w.page.keyboard.press('Enter');
    check('Enter gives the keys back to the rail', (await w.page.evaluate(() => document.activeElement.dataset.id)) === 'g2' && (await w.front()) === 'g2');
    await w.shot('14-games-search');
    await w.page.keyboard.press('/');
    await w.page.keyboard.type('zzz');
    check('a search with no match says so', /No games match/.test(await w.page.textContent('#empty')) && !(await w.page.evaluate(() => document.getElementById('empty').hidden)));
    await w.page.keyboard.press('Escape');
    seen = await w.page.evaluate(() => ({ all: document.querySelectorAll('.dc-cover').length, page: document.getElementById('dash').dataset.page, find: document.querySelector('.dc-find').hidden }));
    check('Escape in the field clears the search and stays on Games', seen.all === 30 && seen.page === 'games' && seen.find, seen);
    // The mouse: a click on a box at the side brings it to the front; the wheel turns the rail.
    await w.page.keyboard.press('Home');
    await w.settled();
    await w.page.click('.dc-cover[data-id=g2]', { position: { x: 300, y: 200 } });
    check('a click on the next box brings it to the front', (await w.front()) === 'g2' && (await w.calls('play')).length === 0, await w.front());
    await w.context.close();
  });

  await scene('Settings: steering, sound, motion, and the Update button through its states', async () => {
    const w = await open();
    await w.goTo('settings');
    const order = [];
    for (let i = 0; i < 6; i++) {
      order.push(await w.page.evaluate(() => document.activeElement.id));
      await w.page.keyboard.press('ArrowDown');
    }
    check('the arrows go down the rows', order.join() === 'update,refresh,sound,volume,motion,motion', order);
    await w.page.keyboard.press('Enter');
    check('A on Motion switches it off', (await w.page.textContent('#motion')) === 'Off' && (await w.page.evaluate(() => document.getElementById('dash').classList.contains('dn-still'))));
    await w.page.keyboard.press('ArrowUp');
    const v0 = await w.page.evaluate(() => Number(document.getElementById('volume').value));
    await w.page.keyboard.press('ArrowRight');
    await w.page.keyboard.press('ArrowRight');
    await w.page.keyboard.press('ArrowLeft');
    const v1 = await w.page.evaluate(() => Number(document.getElementById('volume').value));
    check('left and right change the volume', v0 === 25 && v1 === 30, [v0, v1]);
    await w.page.keyboard.press('ArrowUp');
    await w.page.keyboard.press('a');
    check('A on Sound switches it off', (await w.page.textContent('#sound')) === 'Off');
    const saved = await w.page.evaluate(() => JSON.parse(localStorage.getItem('devious-licks.dashboard')));
    check('the choices are remembered', saved.sound === false && saved.volume === 30 && saved.motion === false, saved);
    await w.shot('08-settings-choices');
    await w.page.keyboard.press('Escape');
    check('with motion off, screens change at once', (await w.page.evaluate(() => document.getElementById('dash').dataset.page)) === 'home');
    await w.page.reload();
    await w.page.waitForSelector('#dash[data-ready]');
    check('...and are still there after the window is opened again', (await w.page.textContent('#motion')) === 'Off' && (await w.page.textContent('#sound')) === 'Off' && (await w.page.evaluate(() => document.getElementById('volume').value)) === '30');
    await w.page.evaluate(() => localStorage.clear());
    await w.page.reload();
    await w.page.waitForSelector('#dash[data-ready]');
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
    await w.goTo('settings');

    // A on Refresh.
    await w.page.keyboard.press('ArrowDown');
    await w.page.keyboard.press('Enter');
    await w.page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'refresh').length === 2);
    check('A on Refresh refreshes the games', /up to date/.test(await w.page.textContent('#toast')));
    await w.page.keyboard.press('ArrowUp');

    // The Update button, state by state, the way the app reports them.
    const button = () => w.page.evaluate(() => {
      const b = document.getElementById('update');
      return { label: b.querySelector('span').textContent, text: b.textContent.trim(), disabled: b.disabled, ready: b.classList.contains('ready'), spinning: b.classList.contains('spinning'), title: b.title };
    });
    const set = (state) => w.page.evaluate((s) => window.__fake.setUpdate(s), state);
    await set({ phase: 'checking' });
    let b = await button();
    check('checking: "Checking…", busy', b.label === 'Checking…' && b.text === 'Checking…' && b.disabled && b.spinning, b);
    await w.shot('09-update-checking');
    await set({ phase: 'available', latest: '9.9.9', size: 5 * 1048576, notes: 'A new look.' });
    b = await button();
    check('available: "Update to 9.9.9", lit, and focused again', b.label === 'Update to 9.9.9' && !b.disabled && b.ready && /5 MB/.test(b.title) && /A new look/.test(b.title) && (await w.page.evaluate(() => document.activeElement.id)) === 'update', b);
    check('home says so as well', /9\.9\.9 is out/.test(await w.page.evaluate(() => document.getElementById('home-version').textContent)));
    await w.shot('09-update-available');
    await set({ phase: 'downloading', latest: '9.9.9', percent: 40 });
    b = await button();
    check('downloading: "Updating… 40%", busy', b.label === 'Updating… 40%' && b.disabled, b);
    await w.shot('09-update-downloading');
    await set({ phase: 'ready', latest: '9.9.9' });
    b = await button();
    check('ready: "Restart to finish"', b.label === 'Restart to finish' && !b.disabled && b.ready, b);
    await w.shot('09-update-ready');
    await w.page.keyboard.press('Enter');
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'update.restart'));
    check('A on it asks the app to restart', /Restart to finish/.test(await w.page.textContent('#toast')));
    await set({ phase: 'download', latest: '10.0.0' });
    b = await button();
    check('a version that needs the full app: "Get 10.0.0"', b.label === 'Get 10.0.0' && b.ready, b);
    await w.page.evaluate(() => document.getElementById('update').click());
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'update.openPage'));
    let notice = await w.page.evaluate(() => ({ hidden: document.getElementById('notice').hidden, text: document.getElementById('notice-text').textContent, page: !document.getElementById('notice-page').hidden }));
    check('...a click explains and opens the download page', !notice.hidden && /needs a fresh download/.test(notice.text) && notice.page, notice);
    await w.shot('09-update-notice');
    await w.page.click('#notice-close');
    check('the notice can be dismissed', await w.page.evaluate(() => document.getElementById('notice').hidden));
    await set({ phase: 'available', latest: '9.9.9', failedBefore: true, why: 'it was set aside after it did not start' });
    b = await button();
    check('a version that failed here before: "Try 9.9.9 again", not lit', b.label === 'Try 9.9.9 again' && !b.ready, b);
    await set({ phase: 'idle' });
    await w.page.evaluate(() => (window.__fake.nextUpdate = { phase: 'error', latest: '9.9.9', error: 'The download stopped half way.' }));
    await w.page.keyboard.press('Enter');
    await w.page.waitForFunction(() => !document.getElementById('notice').hidden);
    notice = await w.page.evaluate(() => ({ text: document.getElementById('notice').textContent.trim().replace(/\s+/g, ' '), error: document.getElementById('notice').classList.contains('error'), page: !document.getElementById('notice-page').hidden }));
    check('an update that fails says so, with the way out', /The update to version 9\.9\.9 didn't go through\. The download stopped half way\..*download page/.test(notice.text) && notice.error && notice.page, notice);
    await w.shot('09-update-error');
    await w.page.click('#notice-page');
    await w.page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'update.openPage').length === 2);
    await set({ phase: 'none' });
    b = await button();
    check('nothing new: plain "Update" again', b.label === 'Update' && !b.disabled && !b.ready, b);
    // What the app's own update test does: a click from outside, whatever screen is up.
    await w.page.keyboard.press('Escape');
    await w.at('home');
    const before = (await w.calls('update.check')).length;
    await w.page.evaluate(() => document.getElementById('update').click());
    await w.page.waitForFunction((n) => window.__calls.filter((c) => c[0] === 'update.check').length > n, before);
    await w.page.waitForFunction(() => /newest version/.test(document.getElementById('toast').textContent));
    check('#update answers a click from the home screen too', true);
    // An update that was passed over is reported at the top of the window, on any screen.
    await set({ phase: 'none', passedOver: { version: '9.9.8', why: 'it was set aside after it did not start' } });
    notice = await w.page.evaluate(() => document.getElementById('notice').textContent.trim().replace(/\s+/g, ' '));
    check('a version that was set aside is reported on the home screen', /Version 9\.9\.8 was downloaded but did not start on this Mac.*went back to version/.test(notice), notice);
    await w.shot('09-update-set-aside-home');
    await w.context.close();
  });

  await scene('with "Reduce motion" on, nothing travels', async () => {
    const w = await open({ reducedMotion: 'reduce' });
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
    const still = await w.page.evaluate(() => ({ still: document.getElementById('dash').classList.contains('dn-still'), motion: document.getElementById('motion').textContent, orb: !document.querySelector('.dn-art-canvas').hidden || !document.querySelector('.dn-art-fallback').hidden }));
    check('motion is off by default then, and the orb is still shown', still.still && still.motion === 'Off' && still.orb, still);
    await w.page.keyboard.press('Enter');
    const now = await w.page.evaluate(() => ({ page: document.getElementById('dash').dataset.page, travelling: document.getElementById('dash').dataset.transitioning || null, flight: document.querySelector('.dn-flight').hidden, focus: document.activeElement.dataset.id }));
    check('A changes the screen at once', now.page === 'games' && !now.travelling && now.flight && now.focus === 'neon', now);
    await w.page.keyboard.press('ArrowRight');
    const moved = await w.page.evaluate(() => document.querySelector('.dc-cover[aria-pressed=true]').style.transform);
    check('the rail jumps instead of sliding', /translate3d\(0(\.00)?px/.test(moved), moved);
    await w.page.keyboard.press('Enter');
    check('starting a game shows the "Starting" screen at once', await w.page.evaluate(() => !document.querySelector('.dc-game-screen').hidden));
    await w.page.keyboard.press('Escape');
    await w.page.keyboard.press('Escape');
    check('B, B: home', (await w.page.evaluate(() => document.getElementById('dash').dataset.page)) === 'home');
    await w.shot('15-reduced-motion-home');
    // Motion can still be asked for by name in Settings.
    await w.goTo('settings');
    await w.page.click('#motion');
    check('Motion: On in Settings wins over the Mac\'s setting', (await w.page.textContent('#motion')) === 'On' && !(await w.page.evaluate(() => document.getElementById('dash').classList.contains('dn-still'))));
    await w.context.close();
  });

  for (const [width, height, name] of [[760, 520, 'small'], [1920, 1080, 'large'], [1440, 900, 'mac'], [1280, 748, 'default']]) {
    await scene(`everything fits in a ${width} by ${height} window`, async () => {
      // (the fourth game, one added from a file, has the kind of name a game file gives it)
      const w = await open({ width, height, games: CATALOG_30.map((g) => (g.id === 'g4' ? { ...g, title: LONG_TITLE } : g)), reducedMotion: 'reduce' });
      await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
      // Is every one of these inside the window, and none on top of another?
      const fits = (selectors) => w.page.evaluate((selectors) => {
        const out = [];
        const rects = [];
        for (const s of selectors) {
          for (const el of document.querySelectorAll(s)) {
            if (el.hidden || el.offsetParent === null) continue;
            const r = el.getBoundingClientRect();
            if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) out.push(`${s} is outside the window: ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)}`);
            rects.push([s, r]);
          }
        }
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const [a, b] = [rects[i][1], rects[j][1]];
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${rects[i][0]} overlaps ${rects[j][0]}`);
          }
        }
        return out;
      }, selectors);
      let bad = await fits(['.dn-item .dn-bar', '.dn-select', '.dn-home-version']);
      check('home', bad.length === 0, bad);
      const stage = await w.page.evaluate(() => {
        const r = document.querySelector('.dn-stage').getBoundingClientRect();
        return { ratio: r.width / r.height, w: r.width, h: r.height, grid: document.querySelector('.dn-grid').getBoundingClientRect().width };
      });
      check('home keeps its shape, centred, and the grid fills the window', Math.abs(stage.ratio - 1672 / 941) < 0.01 && stage.w <= width + 1 && stage.h <= height + 1 && Math.abs(stage.grid - width) < 1, stage);
      await w.shot(`16-${name}-home`);
      await w.goTo('games');
      await w.page.waitForFunction(() => [...document.querySelectorAll('.dc-art')].every((i) => i.complete));
      bad = await fits(['.dc-cover[aria-pressed=true] .dc-box', '.dn-library-controls .dn-prompt', '.dc-info-title', '#filter']);
      check('Games (a catalog game in front)', bad.length === 0, bad);
      await w.page.keyboard.press('ArrowRight');
      await w.page.keyboard.press('ArrowRight');
      await w.page.keyboard.press('ArrowRight');
      bad = await fits(['.dc-cover[aria-pressed=true] .dc-box', '.dn-library-controls .dn-prompt', '.dc-info-title', '#filter']);
      check('Games (a local game in front: four prompts)', bad.length === 0, bad);
      await w.shot(`16-${name}-games`);
      await w.page.keyboard.press('Escape');
      for (const [screen, selectors] of [['rom', ['.dn-panel-title', '#add', '.dn-back', '#add-result']], ['friends', ['.dn-panel-title', '.dn-back']], ['settings', ['.dn-panel-title', '#update', '#refresh', '#sound', '.dn-row-range', '#motion', '.dn-about', '.dn-back']]]) {
        await w.goTo(screen);
        bad = await fits(selectors.map((s) => `[data-view=${screen}] ${s}`));
        check(screen, bad.length === 0, bad);
        await w.shot(`16-${name}-${screen}`);
        await w.page.keyboard.press('Escape');
      }
      await w.context.close();
    });
  }

  await scene('a controller steers it, but only while the window is in use', async () => {
    const w = await open({ options: { gamepad: true } });
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
    const press = async (i, ms = 80) => {
      await w.page.evaluate((i) => (window.__pad.buttons[i] = { pressed: true, value: 1 }), i);
      await w.page.waitForTimeout(ms);
      await w.page.evaluate((i) => (window.__pad.buttons[i] = { pressed: false, value: 0 }), i);
      await w.page.waitForTimeout(60);
    };
    await w.page.evaluate(() => window.dispatchEvent(new Event('gamepadconnected')));
    await press(13);
    check('D-pad down: the next menu item', (await w.page.evaluate(() => document.querySelector('.dn-item[aria-pressed=true]').dataset.page)) === 'rom');
    await press(12);
    await press(0, 500);
    await w.at('games');
    check('A (held a while) selects, once', (await w.calls('play')).length === 0);
    await w.page.evaluate(() => (window.__pad.axes[0] = 0.9));
    await w.page.waitForTimeout(120);
    await w.page.evaluate(() => (window.__pad.axes[0] = 0));
    await w.page.waitForTimeout(60);
    check('the stick moves along the rail', (await w.front()) === 'void', await w.front());
    await press(3);
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'setCover'));
    await press(2);
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'removeLocal'));
    check('Y asks for a picture, X removes', true);
    // The window is not the one in use (a game has the controller): nothing happens.
    await w.page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
      window.dispatchEvent(new Event('blur'));
    });
    await press(0);
    await press(1);
    await w.page.waitForTimeout(200);
    check('a controller is not listened to while another window is in use', (await w.calls('play')).length === 0 && (await w.page.evaluate(() => document.getElementById('dash').dataset.page)) === 'games');
    // Back in the window with B still held down from the game: that press was not meant for the menu.
    await w.page.evaluate(() => (window.__pad.buttons[1] = { pressed: true, value: 1 }));
    await w.page.evaluate(() => {
      delete document.hasFocus;
      window.dispatchEvent(new Event('focus'));
    });
    await w.page.waitForTimeout(200);
    check('a button already held when the window comes back does not count', (await w.page.evaluate(() => document.getElementById('dash').dataset.page)) === 'games');
    await w.page.evaluate(() => (window.__pad.buttons[1] = { pressed: false, value: 0 }));
    await w.page.waitForTimeout(80);
    await press(1);
    await w.at('home');
    check('B, pressed afresh, goes back', true);
    await w.context.close();
  });

  await scene('sound: only after a key or a click, one ambience loop, silent when switched off', async () => {
    const w = await open();
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
    const sound = () => w.page.evaluate(() => import('./dash/sound.js').then((m) => m.soundState()));
    let s = await sound();
    check('no sound before anything was pressed', s.context === 'none' && !s.loop, s);
    await w.page.keyboard.press('ArrowDown');
    await w.page.waitForFunction(() => import('./dash/sound.js').then((m) => m.soundState().loaded.length === 4), null, { timeout: 5000 });
    await w.page.waitForTimeout(200);
    s = await sound();
    check('the four sounds are loaded from their files', s.loaded.sort().join() === 'ambience,back,focus,select', s);
    if (s.context === 'running') {
      check('the ambience loop plays', s.loop, s);
      await w.goTo('settings');
      await w.page.click('#sound');
      await w.page.waitForTimeout(150);
      s = await sound();
      check('Sound: Off stops it', !s.loop && s.context !== 'running', s);
      await w.page.click('#sound');
      await w.page.waitForFunction(() => import('./dash/sound.js').then((m) => m.soundState().loop));
      // The window is not in use: quiet.
      await w.page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
        window.dispatchEvent(new Event('blur'));
      });
      await w.page.waitForTimeout(150);
      s = await sound();
      check('quiet while another window is in use (a game)', !s.loop, s);
    } else console.log(`     (this browser gives no running audio here: ${s.context}; the playing itself was not checked)`);
    await w.context.close();
  });

  await scene('nothing is drawn while the window is not in use', async () => {
    const w = await open({
      before: (page) =>
        page.addInitScript(() => {
          const raf = window.requestAnimationFrame.bind(window);
          window.__frames = 0;
          window.requestAnimationFrame = (fn) => {
            window.__frames++;
            return raf(fn);
          };
        }),
    });
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
    const frames = async (ms) => {
      await w.page.evaluate(() => (window.__frames = 0));
      await w.page.waitForTimeout(ms);
      return w.page.evaluate(() => window.__frames);
    };
    const away = () =>
      w.page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
        window.dispatchEvent(new Event('blur'));
      });
    const back = () =>
      w.page.evaluate(() => {
        delete document.hasFocus;
        window.dispatchEvent(new Event('focus'));
      });
    const homeBusy = await frames(600);
    await away();
    await w.page.waitForTimeout(100);
    const homeIdle = await frames(600);
    check('home: the orb moves while the window is in use, and rests when it is not', homeBusy > 10 && homeIdle <= 1, { homeBusy, homeIdle });
    await back();
    await w.goTo('games');
    await w.settled();
    const gamesBusy = await frames(600);
    await away();
    await w.page.waitForTimeout(100);
    const gamesIdle = await frames(600);
    check('Games: the same for the backdrop', gamesBusy > 3 && gamesIdle <= 1, { gamesBusy, gamesIdle });
    await back();
    await w.page.keyboard.press('Escape');
    await w.at('home');
    await w.goTo('settings');
    await w.page.waitForTimeout(200);
    const settings = await frames(600);
    check('Settings: nothing is animated at all', settings <= 1, settings);
    await w.context.close();
  });

  // ----- what a review of the first version found -----

  await scene('a game that does not start always ends with a message in sight', async () => {
    const w = await open();
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
    await w.goTo('games');
    const state = () => w.page.evaluate(() => ({ screen: document.querySelector('.dn-library').dataset.screen, onScreen: !document.querySelector('.dc-game-screen').hidden && document.querySelector('.dc-game-screen').classList.contains('error') ? document.querySelector('.dc-game-text').textContent : '', toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent }));
    const said = (st) => /Neon Outrun couldn't be started: the game file is missing/.test(st.onScreen) || /Neon Outrun couldn't be started: the game file is missing/.test(st.toast);
    const rail = () => w.page.waitForFunction(() => document.querySelector('.dn-library').dataset.screen === 'home');
    const quiet = () => w.page.evaluate(() => (document.getElementById('toast').hidden = true));
    // 1. The start fails; then a refresh ends and the library is drawn again.
    await w.page.evaluate(() => (window.__fake.playError = 'the game file is missing'));
    await w.page.keyboard.press('Enter');
    await w.page.waitForSelector('.dc-game-screen.error:not([hidden])');
    await w.page.keyboard.press('Control+r');
    await w.page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'refresh').length === 2 && !document.getElementById('refresh').disabled);
    await w.page.waitForTimeout(100);
    let st = await state();
    check('a refresh that ends while "Not started" is up leaves the message in sight', said(st), st);
    check('...on its screen, which still waits for B', st.screen === 'game' && Boolean(st.onScreen), st);
    await w.page.keyboard.press('Escape');
    await rail();
    await quiet();
    // 2. The start fails late, after a redraw. (The refresh is slow and ends first.)
    await w.page.evaluate(() => Object.assign(window.__fake, { playDelay: 1200, refreshDelay: 300 }));
    await w.page.keyboard.press('Enter');
    await w.page.keyboard.press('Control+r');
    await w.page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'refresh').length === 3 && !document.getElementById('refresh').disabled);
    await w.page.waitForTimeout(1500);
    st = await state();
    check('a start that fails after the library was redrawn still says so', said(st), st);
    await w.page.keyboard.press('Escape');
    await rail();
    await quiet();
    // 3. B before a slow start fails.
    await w.page.keyboard.press('Enter');
    await w.page.waitForTimeout(150);
    await w.page.keyboard.press('Escape');
    await rail();
    await w.page.waitForTimeout(1400);
    st = await state();
    check('B before a slow start fails: the failure is still reported, in a message', /Neon Outrun couldn't be started: the game file is missing/.test(st.toast) && st.screen === 'home', st);
    await w.shot('22-start-failed-after-back');
    await quiet();
    // 4. "Not started" is up, and a game dropped on the window takes its place: both are said.
    await w.page.evaluate(() => Object.assign(window.__fake, { playDelay: 0, refreshDelay: 0 }));
    await w.page.keyboard.press('Enter');
    await w.page.waitForSelector('.dc-game-screen.error:not([hidden])');
    await w.page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(64)], 'Late Arrival.z64'));
      document.getElementById('dash').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await w.page.waitForFunction(() => document.querySelector('.dc-cover[aria-pressed=true]').dataset.id === 'local-late-arrival');
    await w.page.waitForTimeout(100);
    st = await state();
    check('a redraw that replaces the "Not started" screen moves what it said into a message, next to the news', /couldn't be started: the game file is missing/.test(st.toast) && /Added Late Arrival/.test(st.toast) && st.screen === 'home', st);
    // 5. The same game, changed under a start that is still running (it got a picture): the screen stays and ends well.
    await quiet();
    await w.page.evaluate(() => Object.assign(window.__fake, { playError: null, playDelay: 900 }));
    await w.page.keyboard.press('Enter');
    await w.page.waitForTimeout(200);
    await w.page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(64)], 'box.png', { type: 'image/png' }));
      document.querySelector('.dc-rail').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await w.page.waitForFunction(() => /opens in its own window/.test(document.querySelector('.dc-game-text').textContent) && !document.querySelector('.dc-game-screen').hidden, null, { timeout: 4000 });
    await w.page.waitForFunction(() => document.querySelector('.dn-library').dataset.screen === 'home', null, { timeout: 7000 });
    check('a start that outlives a redraw of its own game ends on the rail, on that game, with its new picture', (await w.front()) === 'local-late-arrival' && (await w.page.evaluate(() => Boolean(document.querySelector('.dc-cover[aria-pressed=true] .dc-art') && document.activeElement.dataset.id === 'local-late-arrival'))), await w.front());
    await w.context.close();
  });

  await scene('a refresh error can be read in full, at the smallest window too', async () => {
    for (const [width, height] of [[760, 520], [1280, 748]]) {
      const w = await open({ width, height });
      await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
      await w.page.evaluate(() => (window.__fake.refreshFailed = ['Neon Outrun: Could not download file (HTTP 503)', 'Rift Breaker: ROM download was corrupted (hash mismatch)', 'Wide Load: Could not download file (HTTP 503)']));
      await w.page.keyboard.press('Control+r');
      await w.page.waitForFunction(() => /couldn't update/.test(document.getElementById('status').textContent));
      const seen = await w.page.evaluate(() => {
        const s = document.getElementById('status');
        const r = s.getBoundingClientRect();
        return { cut: s.scrollWidth > s.clientWidth + 1, lines: Math.round(r.height / 14), inside: r.left >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight, text: s.textContent.length };
      });
      check(`${width} wide: the whole text is shown, on as many lines as it takes`, !seen.cut && seen.lines >= 2 && seen.inside, seen);
      if (width === 760) await w.shot('23-small-refresh-error');
      await w.context.close();
    }
  });

  await scene('from Load ROM to Games with a new game: the Load ROM screen does not stay in the picture', async () => {
    const w = await open();
    await w.goTo('rom');
    // Looks at every frame of the flight: the screen left behind, and what is painted over it early on.
    const watch = w.page.evaluate(() => new Promise((resolve) => {
      const dash = document.getElementById('dash');
      const rom = document.querySelector('[data-view=rom]');
      const flight = document.querySelector('.dn-flight');
      const out = { started: false, romSeenAfterFifth: 0, paintedBeforeCell: 0, frames: 0 };
      const t0 = performance.now();
      (function look() {
        const p = Number(dash.dataset.flightProgress || -1);
        if (dash.dataset.transitioning) {
          out.started = true;
          out.frames++;
          if (p > 0.2 && !rom.hidden && Number(getComputedStyle(rom).opacity) > 0.02) out.romSeenAfterFifth++;
          if (p > 0.05 && p < 0.28 && flight.width > 1) {
            const data = flight.getContext('2d').getImageData(0, 0, flight.width, flight.height).data;
            let alpha = 0;
            for (let i = 3; i < data.length; i += 4 * 97) alpha += data[i];
            if (alpha > 0) out.paintedBeforeCell++;
          }
        } else if (out.started || performance.now() - t0 > 6000) return resolve(out);
        requestAnimationFrame(look);
      })();
    }));
    await w.page.keyboard.press('Enter');
    const seen = await watch;
    await w.at('games');
    check('there is a flight', seen.started && seen.frames > 5, seen);
    check('the Load ROM screen has faded out within the first fifth of it', seen.romSeenAfterFifth === 0, seen);
    check('the home hub (which was not on screen) is not flown past', seen.paintedBeforeCell === 0, seen);
    check('the new game is in front and focused at the end', (await w.front()) === 'local-picked-game' && (await w.page.evaluate(() => document.activeElement.dataset.id)) === 'local-picked-game');
    await w.context.close();
  });

  await scene('a press on a box that is let go elsewhere does not leave the rail following the mouse', async () => {
    const w = await open();
    await w.goTo('games');
    await w.settled();
    const box = await w.page.evaluate(() => {
      const r = document.querySelector('.dc-cover[aria-pressed=true]').getBoundingClientRect();
      const b = document.querySelector('.dn-home-back').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, bx: b.left + b.width / 2, by: b.top + b.height / 2 };
    });
    // Press on the front box, move straight down, let go on the B BACK prompt (which is not part of the rail).
    await w.page.mouse.move(box.x, box.y);
    await w.page.mouse.down();
    await w.page.mouse.move(box.x, box.y + 60, { steps: 4 });
    await w.page.mouse.move(box.bx, box.by);
    const outside = await w.page.evaluate(({ x, y }) => !document.querySelector('.dc-rail').contains(document.elementFromPoint(x, y)), { x: box.bx, y: box.by });
    await w.page.mouse.up();
    await w.page.waitForTimeout(100);
    check('(the button comes up outside the rail)', outside);
    const page0 = await w.page.evaluate(() => document.getElementById('dash').dataset.page);
    await w.page.mouse.move(box.x + 250, box.y, { steps: 6 });
    await w.page.mouse.move(box.x - 250, box.y, { steps: 10 });
    await w.settled();
    check('moving the mouse over the rail afterwards, no button down, turns nothing', (await w.front()) === 'neon' && page0 === 'games', [await w.front(), page0]);
    // The button comes up where no event tells of it (the window's drag strip in the real app).
    await w.page.evaluate(({ x, y }) => {
      const rail = document.querySelector('.dc-rail');
      const at = (type, dx, buttons) => rail.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, button: type === 'pointerdown' ? 0 : -1, buttons, clientX: x + dx, clientY: y }));
      at('pointerdown', 0, 1);
      for (const dx of [-40, -120, -200, -280]) at('pointermove', dx, 0);
    }, box);
    await w.settled();
    check('...nor when the release was never heard of at all', (await w.front()) === 'neon', await w.front());
    // An ordinary drag still turns the rail.
    await w.page.mouse.move(box.x, box.y);
    await w.page.mouse.down();
    await w.page.mouse.move(box.x - 300, box.y, { steps: 8 });
    await w.page.mouse.up();
    await w.settled();
    check('a real drag still does', (await w.front()) !== 'neon', await w.front());
    await w.context.close();
  });

  await scene('a mouse pointer resting on the menu does not take the choice when home comes back', async () => {
    const w = await open();
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
    const bar = await w.page.evaluate(() => {
      const r = document.querySelector('.dn-item[data-page=friends] .dn-bar').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const chosen = () => w.page.evaluate(() => document.querySelector('.dn-item[aria-pressed=true]').dataset.page);
    await w.page.mouse.move(bar.x - 30, bar.y - 4);
    await w.page.mouse.move(bar.x, bar.y, { steps: 3 });
    check('a pointer that moves onto an item chooses it', (await chosen()) === 'friends', await chosen());
    await w.page.keyboard.press('ArrowUp');
    await w.page.keyboard.press('ArrowUp');
    check('the keys move on from there', (await chosen()) === 'games');
    await w.page.keyboard.press('Enter');
    await w.at('games');
    await w.page.keyboard.press('Escape');
    await w.at('home');
    await w.page.waitForTimeout(400);
    const after = await w.page.evaluate(() => ({ chosen: document.querySelector('.dn-item[aria-pressed=true]').dataset.page, focus: document.activeElement.dataset.page }));
    check('home again: still Games, chosen and focused, though the pointer rests on Friends', after.chosen === 'games' && after.focus === 'games', after);
    await w.page.keyboard.press('Enter');
    await w.at('games');
    await w.context.close();
  });

  await scene('Settings with the sound off: Volume is stepped over and cannot be changed', async () => {
    const w = await open({ reducedMotion: 'reduce' });
    await w.goTo('settings');
    await w.page.keyboard.press('ArrowDown');
    await w.page.keyboard.press('ArrowDown');
    await w.page.keyboard.press('Enter');
    check('(Sound is off)', (await w.page.textContent('#sound')) === 'Off' && (await w.page.evaluate(() => document.getElementById('volume').disabled)));
    await w.page.keyboard.press('ArrowDown');
    const down = await w.page.evaluate(() => ({ focus: document.activeElement.id, current: [...document.querySelectorAll('[data-view=settings] [data-current]')].map((e) => e.id || e.className) }));
    check('Down from Sound goes to Motion', down.focus === 'motion' && down.current.join() === 'motion', down);
    await w.page.keyboard.press('ArrowUp');
    check('Up from Motion goes back to Sound', (await w.page.evaluate(() => document.activeElement.id)) === 'sound');
    await w.page.keyboard.press('ArrowLeft');
    await w.page.keyboard.press('ArrowLeft');
    await w.page.keyboard.press('ArrowRight');
    const kept = await w.page.evaluate(() => ({ value: document.getElementById('volume').value, saved: JSON.parse(localStorage.getItem('devious-licks.dashboard')).volume }));
    check('Left and Right leave the volume alone', kept.value === '25' && kept.saved === 25, kept);
    await w.page.keyboard.press('Enter');
    await w.page.keyboard.press('ArrowDown');
    check('with the sound on again, Down lands on Volume', (await w.page.evaluate(() => document.activeElement.id)) === 'volume');
    await w.context.close();
  });

  await scene('messages keep clear of the search field on Games and of the rows on Settings', async () => {
    for (const [width, height, name] of [[760, 520, 'small'], [1280, 748, 'default']]) {
      const w = await open({ width, height, games: CATALOG_30, reducedMotion: 'reduce' });
      await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'up'));
      const apart = (a, b) => w.page.evaluate(([a, b]) => {
        const [p, q] = [document.querySelector(a).getBoundingClientRect(), document.querySelector(b).getBoundingClientRect()];
        const c = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
        return { clear: !(p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom) && p.width > 0 && q.width > 0, onTop: c ? c.id || c.className : null, inside: p.top >= 0 && p.bottom <= innerHeight && p.left >= 0 && p.right <= innerWidth };
      }, [a, b]);
      await w.goTo('games');
      await w.page.keyboard.press('Control+r');
      await w.page.waitForFunction(() => !document.getElementById('toast').hidden);
      await w.page.keyboard.press('/');
      await w.page.keyboard.type('number 1');
      let seen = await apart('#toast', '#search');
      check(`${width} wide, Games: a toast does not lie on the search field being typed in`, seen.clear && seen.onTop === 'search' && seen.inside, seen);
      await w.page.evaluate(() => window.__fake.setUpdate({ phase: 'none', passedOver: { version: '9.9.8', why: 'it was set aside after it did not start' } }));
      seen = await apart('#notice', '#search');
      const chip = await apart('#notice', '#filter');
      check(`${width} wide, Games: nor does a notice, on the field or on the console chip`, seen.clear && seen.onTop === 'search' && chip.clear, [seen, chip]);
      await w.shot(`18-${name}-toast-with-search`);
      await w.page.click('#notice-close');
      await w.page.keyboard.press('Escape');
      await w.page.keyboard.press('Escape');
      check('(home again)', (await w.page.evaluate(() => document.getElementById('dash').dataset.page)) === 'home');
      // Settings: the notice that says "Click Try ... again" must not lie on that button.
      await w.goTo('settings');
      await w.page.evaluate(() => (window.__fake.nextUpdate = { phase: 'available', latest: '0.4.1', failedBefore: true, why: 'it was set aside after it did not start' }));
      await w.page.keyboard.press('Enter');
      await w.page.waitForFunction(() => !document.getElementById('notice').hidden);
      for (const row of ['#update', '#refresh', '#sound', '#volume', '#motion', '[data-view=settings] .dn-back', '[data-view=settings] .dn-panel-title']) {
        seen = await apart('#notice', row);
        check(`${width} wide, Settings: the update notice keeps clear of ${row}`, seen.clear && seen.inside, seen);
      }
      check('...and the button it speaks of reads as it says', (await w.page.textContent('#update')).trim() === 'Try 0.4.1 again' && /Try 0\.4\.1 again/.test(await w.page.textContent('#notice-text')));
      await w.shot(`19-${name}-update-notice`);
      await w.context.close();
    }
  });

  await scene('a sound file that is missing means no sound, not a broken window', async () => {
    const w = await open({ allow: /audio\/|Failed to load resource/, before: (page) => page.route('**/audio/*.wav', (route) => route.fulfill({ status: 404, body: 'gone' })) });
    await w.page.keyboard.press('Enter');
    await w.at('games');
    await w.page.keyboard.press('Enter');
    await w.page.waitForFunction(() => window.__calls.some((c) => c[0] === 'play'));
    check('everything still works', true);
    await w.context.close();
  });

  await scene('a library that cannot be opened leaves the Update button usable', async () => {
    const w = await open({ before: (page) => page.addInitScript(() => (window.__fake.getError = 'the library file is damaged')) });
    await w.page.waitForFunction(() => !document.getElementById('notice').hidden);
    const seen = await w.page.evaluate(() => ({ notice: document.getElementById('notice-text').textContent, up: window.__calls.some((c) => c[0] === 'up'), version: document.getElementById('version').textContent }));
    check('it says so, and does not tell the app that all is well', /couldn't be opened/.test(seen.notice) && !seen.up, seen);
    await w.goTo('settings');
    await w.page.keyboard.press('Enter');
    await w.page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'update.check').length >= 2);
    check('the Update button works', true);
    await w.context.close();
  });

  await scene('a dashboard that cannot start still shows the Update button', async () => {
    const w = await open({ options: { broken: true }, allow: /main\.js|Failed to load resource|Failed to fetch dynamically/, before: (page) => page.route('**/dash/main.js', (route) => route.fulfill({ status: 500, body: 'broken' })) });
    await w.page.waitForFunction(() => !document.getElementById('notice').hidden);
    await w.page.waitForFunction((v) => document.getElementById('version').textContent === `Version ${v}`, VERSION);
    const seen = await w.page.evaluate(() => {
      const r = document.getElementById('update').getBoundingClientRect();
      return { fallback: document.documentElement.classList.contains('dl-fallback'), visible: r.width > 50 && r.height > 20 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === document.querySelector('#update') || document.querySelector('#update').contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), up: window.__calls.some((c) => c[0] === 'up') };
    });
    check('the Settings rows are shown plainly, and the app is not told that all is well', seen.fallback && seen.visible && !seen.up, seen);
    await w.page.click('#update');
    await w.page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'update.check').length >= 2);
    check('a click on Update reaches the app', true);
    await w.shot('17-fallback');
    await w.context.close();
  });

  await browser.close();
  server.close();
  const seconds = Math.round((Date.now() - started) / 1000);
  if (failures) {
    console.log(`\n${failures} of ${checks} checks failed (${seconds} s).`);
    process.exit(1);
  }
  console.log(`\nDashboard check passed: ${checks} checks in ${seconds} s.${SHOTS ? ` Pictures are in ${SHOTS}` : ''}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
