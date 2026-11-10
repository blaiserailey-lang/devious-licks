#!/usr/bin/env node
// Runs an N64 game file in the web (WebAssembly) build of the same emulator
// core, in a headless browser, and reports what it does: frames run, whether
// the picture keeps changing, the pitch of the sound, and screenshots.
//
// It is a second opinion that needs no Mac: the native player can only be run
// on macOS (GitHub's build machines), this runs anywhere Chromium does. Use it
// to try a new test cartridge before it goes into selftest.sh, or to see how a
// game behaves with different emulator options (a freeze shows up as a picture
// that stops changing while the frame count keeps going).
//
//   node player/test/reference/run.js <game file> [--seconds 20] [--step 5]
//        [--options '{"mupen64plus-CountPerOp":"1"}'] [--shots <folder>]
//        [--press "12:Enter,15:x"] [--app]
//
//   --press   keys to tap, each at a number of seconds into the run
//             (Enter = Start, x = A, s = B, arrows = D-pad; EmulatorJS defaults)
//   --app     use the launcher's own web player page (src/renderer/player.html)
//             instead of a bare page
//
// Needs Playwright with Chromium (npm i -D playwright, or a machine that has
// it) and the vendored emulator (npm install fills vendor/). The game file is
// read from where it is and served to the browser on this machine only;
// nothing is copied or uploaded.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args.splice(i, 2)[1]; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const seconds = Number(flag('--seconds', 20));
const step = Number(flag('--step', 5));
const options = flag('--options', '');
const shots = flag('--shots', '');
const presses = String(flag('--press', '')).split(',').filter(Boolean).map((p) => { const [at, key] = p.split(':'); return { at: Number(at), key }; });
const useApp = has('--app');
const rom = args[0];
if (!rom || !fs.existsSync(rom)) { console.error('usage: run.js <game file> [--seconds n] [--step n] [--options json] [--shots folder] [--press "s:key,..."] [--app]'); process.exit(2); }
if (options) JSON.parse(options); // fail early on a typo

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };
const BARE = `<!doctype html><meta charset="utf-8"><title>reference</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#game{width:640px;height:480px}</style>
<div id="game"></div><script>
window.EJS_player = '#game';
window.EJS_core = 'n64';
window.EJS_gameName = 'reference';
window.EJS_gameID = 'reference';
window.EJS_gameUrl = '/rom/game.z64';
window.EJS_pathtodata = '/vendor/emulatorjs/data/';
window.EJS_DEBUG_XX = true;
window.EJS_startOnLoaded = true;
window.EJS_language = 'en-US';
window.EJS_disableAutoLang = true;
// Without saved settings the options go into the core's option file before it
// starts; otherwise EmulatorJS applies them once the core is already running.
window.EJS_disableLocalStorage = true;
const options = new URLSearchParams(location.search).get('options');
if (options) window.EJS_defaultOptions = JSON.parse(options);
const s = document.createElement('script'); s.src = window.EJS_pathtodata + 'loader.js'; document.body.append(s);
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (file) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  };
  if (url.pathname === '/bare.html') { res.writeHead(200, { 'content-type': 'text/html' }).end(BARE); return; }
  if (url.pathname.startsWith('/rom/')) { send(path.resolve(rom)); return; }
  const file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!/^\/(vendor|src)\//.test(url.pathname) || !file.startsWith(ROOT + path.sep)) { res.writeHead(404).end('not found'); return; }
  send(file);
});

(async () => {
  const { chromium } = require('playwright');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
  // Listen in on the sound the emulator plays: how much, how loud, what pitch
  // (a steady tone swings from one side of silence to the other twice a cycle).
  await page.addInitScript(() => {
    const sound = (window.__sound = { buffers: 0, frames: 0, loudest: 0, swings: 0, first: -1, last: -1, side: 0, rate: 0 });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      try {
        const d = this.buffer.getChannelData(0);
        sound.buffers++;
        sound.rate = this.buffer.sampleRate;
        for (let i = 0; i < d.length; i++) {
          const side = d[i] > 0.015 ? 1 : d[i] < -0.015 ? -1 : 0;
          if (Math.abs(d[i]) > sound.loudest) sound.loudest = Math.abs(d[i]);
          if (side && side !== sound.side) { if (sound.first < 0) sound.first = sound.frames + i; sound.last = sound.frames + i; sound.swings++; sound.side = side; }
        }
        sound.frames += d.length;
      } catch { /* not a buffer we can read */ }
      return start.apply(this, a);
    };
  });
  const log = [];
  page.on('console', (m) => { const t = m.text(); if (!/glMapBufferRange|Translation not found|SYSTEM.DIR|SYSTEM_DIRECTORY/.test(t)) log.push(`[${m.type()}] ${t}`); });
  page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
  const query = new URLSearchParams(useApp
    ? { core: 'n64', title: 'Reference', saveId: 'reference-1', romUrl: '/rom/game.z64', ...(options ? { options } : {}) }
    : (options ? { options } : {}));
  await page.goto(`${origin}${useApp ? '/src/renderer/player.html' : '/bare.html'}?${query}`);
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), ms))]);
  const started = Date.now();
  let before = '', focused = false;
  const pending = [...presses].sort((a, b) => a.at - b.at);
  for (let tick = 1; (Date.now() - started) / 1000 < seconds; tick++) {
    const until = Math.min(tick * step, seconds);
    while ((Date.now() - started) / 1000 < until) {
      const now = (Date.now() - started) / 1000;
      if (pending.length && pending[0].at <= now) {
        const { key } = pending.shift();
        if (!focused) { await page.mouse.click(320, 240); focused = true; }
        await page.keyboard.down(key); await page.waitForTimeout(120); await page.keyboard.up(key);
        console.log(`  ${now.toFixed(0)} s: pressed ${key}`);
      }
      await page.waitForTimeout(100);
    }
    const wall = ((Date.now() - started) / 1000).toFixed(0);
    const frame = await within(page.evaluate(() => { try { return window.EJS_emulator.gameManager.getFrameNum(); } catch { return 'not started'; } }).catch(() => 'page gone'), 8000);
    const shot = await within(page.screenshot({ timeout: 8000 }).catch(() => null), 9000);
    let picture = 'none';
    if (shot && shot !== 'TIMEOUT') {
      picture = crypto.createHash('md5').update(shot).digest('hex').slice(0, 8);
      if (shots && picture !== before) fs.writeFileSync(path.join(shots, `t${String(wall).padStart(4, '0')}.png`), shot);
    }
    console.log(`${wall} s: frame ${frame}, picture ${picture}${picture === before ? ' (unchanged)' : ''}`);
    before = picture;
  }
  const sound = await within(page.evaluate(() => window.__sound).catch(() => null), 5000);
  if (sound && sound !== 'TIMEOUT') {
    const pitch = sound.swings > 1 && sound.last > sound.first ? (sound.swings - 1) / 2 * sound.rate / (sound.last - sound.first) : 0;
    console.log(`sound: ${sound.frames} frames in ${sound.buffers} buffers at ${sound.rate} Hz, loudest ${sound.loudest.toFixed(3)}, swings ${sound.swings} (a steady tone would be ${pitch.toFixed(0)} Hz)`);
  }
  if (shots) fs.writeFileSync(path.join(shots, 'console.log'), log.join('\n') + '\n');
  await browser.close();
  server.close();
})().catch((err) => { console.error(err); process.exit(1); });
