const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const packs = require('../src/packs');
const { Updater, friendly } = require('../src/updater');
const { tmp, describe, makePack, serve } = require('./helpers');

const FILES = { 'app.asar': 'the app, version 0.3.3 '.repeat(5000), 'player/dl-player': 'player v2', 'player/core.dylib': 'core v1' };

// A release on the pretend GitHub: update.json plus the files it lists.
function release(version, files = FILES, extra = {}) {
  const manifest = describe(version, files, extra);
  const routes = { '/update.json': JSON.stringify(manifest) };
  for (const [to, body] of Object.entries(files)) routes[`/v${version}/${path.basename(to)}`] = body;
  return { manifest, routes };
}

function updater(site, { dir = tmp('dl-upd-'), version = '0.3.2', bundledVersion = '0.3.2', electron = '45.2.3', places = [], allowed, files = fs, patience, ...more } = {}) {
  const changes = [];
  const u = new Updater({
    fs: files, fetch, dir,
    feed: `${site.base}/update.json`,
    fileUrl: (v, name) => `${site.base}/v${v}/${name}`,
    allowed: allowed || ((url) => url.startsWith(site.base)),
    running: { version, bundledVersion, electron, places, ...more },
    onChange: (view) => changes.push(view),
    patience,
  });
  return { u, dir, changes };
}

test('nothing newer: up to date', async () => {
  const site = await serve(release('0.3.2').routes);
  try {
    const { u } = updater(site);
    assert.strictEqual((await u.check()).phase, 'none');
    assert.strictEqual((await u.install()).phase, 'none', 'nothing to install');
  } finally { await site.close(); }
});

test('no update information published (404): nothing to install, and not an error', async () => {
  const site = await serve({});
  try {
    const found = await updater(site).u.check();
    assert.strictEqual(found.phase, 'none');
    assert.strictEqual(found.unknown, true, 'which is not the same as "you have the newest version"');
    const real = await serve(release('0.3.2').routes);
    try {
      assert.strictEqual((await updater(real).u.check()).unknown, undefined);
    } finally { await real.close(); }
  } finally { await site.close(); }
});

test('a newer version is found, downloaded, checked and made current', async () => {
  const { routes, manifest } = release('0.3.3', FILES, { notes: 'Faster menus' });
  const site = await serve(routes);
  try {
    const { u, dir, changes } = updater(site);
    const found = await u.check();
    assert.strictEqual(found.phase, 'available');
    assert.strictEqual(found.latest, '0.3.3');
    assert.strictEqual(found.notes, 'Faster menus');
    assert.strictEqual(found.size, manifest.files.reduce((n, f) => n + f.size, 0));
    assert.strictEqual(found.failedBefore, false);
    const done = await u.install();
    assert.strictEqual(done.phase, 'ready');
    for (const [to, body] of Object.entries(FILES)) assert.strictEqual(fs.readFileSync(path.join(dir, '0.3.3', to), 'utf8'), body);
    assert.strictEqual(fs.statSync(path.join(dir, '0.3.3', 'player', 'dl-player')).mode & 0o777, 0o755);
    assert.strictEqual(fs.statSync(path.join(dir, '0.3.3', 'app.asar')).mode & 0o777, 0o644);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')), { version: '0.3.3' });
    assert.ok(!fs.existsSync(path.join(dir, 'staging-0.3.3')));
    assert.strictEqual(packs.choose({ fs, dir, bundledVersion: '0.3.2', electron: '45.2.3' }).version, '0.3.3', 'the next start picks it');
    const percents = changes.filter((c) => c.phase === 'downloading').map((c) => c.percent);
    assert.ok(percents.length >= 2 && percents.every((p, i) => p >= 0 && p <= 99 && (i === 0 || p > percents[i - 1])), `progress climbs: ${percents}`);
    // asking again reports it as waiting for a restart, without downloading twice
    const again = await u.check();
    assert.strictEqual(again.phase, 'ready');
    assert.strictEqual(site.hits['/v0.3.3/app.asar'], 1);
  } finally { await site.close(); }
});

test('files that did not change are copied from the running version, not downloaded', async () => {
  const site = await serve(release('0.3.3').routes);
  try {
    const running = tmp('dl-run-');
    fs.mkdirSync(path.join(running, 'player'));
    fs.writeFileSync(path.join(running, 'player', 'core.dylib'), FILES['player/core.dylib']);  // same
    fs.writeFileSync(path.join(running, 'player', 'dl-player'), 'player v1');                  // changed, same size
    fs.writeFileSync(path.join(running, 'app.asar'), 'old code');                              // changed
    const { u, dir } = updater(site, { places: [path.join(running, 'missing'), running] });
    await u.check();
    assert.strictEqual((await u.install()).phase, 'ready');
    assert.strictEqual(site.hits['/v0.3.3/core.dylib'], undefined);
    assert.strictEqual(site.hits['/v0.3.3/dl-player'], 1);
    assert.strictEqual(site.hits['/v0.3.3/app.asar'], 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, '0.3.3', 'player', 'core.dylib'), 'utf8'), FILES['player/core.dylib']);
    assert.strictEqual(fs.readFileSync(path.join(dir, '0.3.3', 'player', 'dl-player'), 'utf8'), FILES['player/dl-player']);
  } finally { await site.close(); }
});

test('a download that does not match its hash or size is refused and nothing changes', async () => {
  for (const damage of [
    (body) => body.replace('version', 'VERSION'),       // same size, different content
    (body) => body.slice(0, -10),                       // cut short
    (body) => `${body}extra`,                           // too long
  ]) {
    const { routes } = release('0.3.3');
    routes['/v0.3.3/app.asar'] = damage(FILES['app.asar']);
    const site = await serve(routes);
    try {
      const { u, dir } = updater(site);
      await u.check();
      const result = await u.install();
      assert.strictEqual(result.phase, 'error');
      assert.match(result.error, /intact|larger/);
      assert.ok(!fs.existsSync(path.join(dir, '0.3.3')));
      assert.ok(!fs.existsSync(path.join(dir, 'current.json')));
      assert.ok(!fs.existsSync(path.join(dir, 'staging-0.3.3')));
      assert.strictEqual(packs.choose({ fs, dir, bundledVersion: '0.3.2', electron: '45.2.3' }), null);
    } finally { await site.close(); }
  }
});

test('a missing file on the server is an error that can be retried', async () => {
  const { routes } = release('0.3.3');
  const asar = routes['/v0.3.3/app.asar'];
  delete routes['/v0.3.3/app.asar'];
  const site = await serve(routes);
  try {
    const { u, dir } = updater(site);
    await u.check();
    assert.strictEqual((await u.install()).phase, 'error');
    assert.ok(!fs.existsSync(path.join(dir, 'current.json')));
    site.routes['/v0.3.3/app.asar'] = asar;
    assert.strictEqual((await u.check()).phase, 'available');
    assert.strictEqual((await u.install()).phase, 'ready');
  } finally { await site.close(); }
});

test('an update for another engine, a newer installed app or a later format needs the full download', async () => {
  for (const [extra, running, why] of [
    [{ electron: '46.0.0' }, {}, /engine 46\.0\.0/],
    [{ needsApp: '0.4.0' }, {}, /0\.4\.0 or later/],
    [{ needsApp: '0.3.3' }, { version: '0.3.4', bundledVersion: '0.3.2' }, /0\.3\.3 or later/], // running a pack on an old installed app
  ]) {
    const site = await serve(release('0.5.0', FILES, extra).routes);
    try {
      const { u, dir } = updater(site, running);
      const found = await u.check();
      assert.strictEqual(found.phase, 'download', JSON.stringify(extra));
      assert.strictEqual(found.latest, '0.5.0');
      assert.match(found.why, why);
      assert.strictEqual((await u.install()).phase, 'download', 'install does nothing');
      assert.ok(!fs.existsSync(path.join(dir, '0.5.0')));
    } finally { await site.close(); }
  }
  const later = await serve({ '/update.json': JSON.stringify({ format: 2, version: '1.0.0', shape: 'unknown' }) });
  try {
    const found = await updater(later).u.check();
    assert.strictEqual(found.phase, 'download');
    assert.match(found.why, /later format/);
  } finally { await later.close(); }
  // another build of the same engine is fine
  const same = await serve(release('0.5.0', FILES, { electron: '45.9.1' }).routes);
  try {
    assert.strictEqual((await updater(same).u.check()).phase, 'available');
  } finally { await same.close(); }
});

test('the start-up code of the installed app is asked before anything is downloaded', async () => {
  const site = await serve(release('0.3.3').routes);
  try {
    const asked = [];
    const { u, dir } = updater(site, { accepts: (info) => { asked.push(info); return 'it has more files than this app can take'; } });
    const found = await u.check();
    assert.strictEqual(found.phase, 'download');
    assert.strictEqual(found.why, 'it has more files than this app can take');
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].version, '0.3.3');
    assert.strictEqual((await u.install()).phase, 'download');
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.strictEqual(site.hits['/v0.3.3/app.asar'], undefined);
    // one that says yes, or that breaks, does not stand in the way
    assert.strictEqual((await updater(site, { accepts: () => '' }).u.check()).phase, 'available');
    assert.strictEqual((await updater(site, { accepts: () => { throw new Error('old'); } }).u.check()).phase, 'available');
  } finally { await site.close(); }
});

test('bad update information is an error, never an install', async () => {
  const odd = (version) => JSON.stringify({ ...describe(version, FILES), files: [{ name: 'x', to: '../x', size: 1, sha256: 'a'.repeat(64) }] });
  for (const body of ['not json', '{"format":1}', 'null', '[]', odd('0.3.2'), odd('0.3'), 'x'.repeat(200000)]) {
    const site = await serve({ '/update.json': body });
    try {
      const { u, dir } = updater(site);
      const found = await u.check();
      assert.strictEqual(found.phase, 'error', body.slice(0, 30));
      assert.ok(found.error.length > 0);
      assert.strictEqual((await u.install()).phase, 'error');
      assert.deepStrictEqual(fs.readdirSync(dir), []);
    } finally { await site.close(); }
  }
});

test('update information this version cannot read, but which names a newer version, means "get the full download"', async () => {
  // what a much later release might publish: nothing this code can check, but a version it can compare
  const bodies = [
    JSON.stringify({ ...describe('0.9.0', FILES), files: [{ name: 'x', to: '../x', size: 1, sha256: 'a'.repeat(64) }] }),
    JSON.stringify({ format: 1, version: '0.9.0', electron: '45.2.3', files: Array.from({ length: 600 }, (_, i) => ({ name: `f${i}`, to: `f${i}`, size: 1, sha256: 'a'.repeat(64) })) }),
    JSON.stringify({ version: '0.9.0' }),
  ];
  for (const body of bodies) {
    const site = await serve({ '/update.json': body });
    try {
      const { u, dir } = updater(site);
      const found = await u.check();
      assert.strictEqual(found.phase, 'download', body.slice(0, 40));
      assert.strictEqual(found.latest, '0.9.0');
      assert.ok(found.why.length > 0);
      assert.strictEqual((await u.install()).phase, 'download', 'nothing is installed from it');
      assert.deepStrictEqual(fs.readdirSync(dir), []);
    } finally { await site.close(); }
  }
});

test('a server that never answers, or goes quiet part-way, is given up on', async () => {
  const { routes } = release('0.3.3');
  const asar = routes['/v0.3.3/app.asar'];
  const hanging = [];
  const never = (req, res) => { hanging.push(res); };
  const half = (req, res) => { hanging.push(res); res.writeHead(200); res.write(asar.slice(0, 1000)); };
  const site = await serve({ ...routes });
  const patience = { answer: 250, idle: 250 };
  try {
    // update.json: no answer at all, then an answer that stops in the middle
    const json = site.routes['/update.json'];
    for (const quiet of [never, (req, res) => { hanging.push(res); res.writeHead(200); res.write(json.slice(0, 20)); }]) {
      site.routes['/update.json'] = quiet;
      const { u } = updater(site, { patience });
      const started = Date.now();
      const found = await u.check();
      assert.strictEqual(found.phase, 'error');
      assert.match(found.error, /went quiet/);
      assert.ok(Date.now() - started < 5000, 'it does not wait for ever');
    }
    site.routes['/update.json'] = json;
    // a file: the same two ways
    for (const quiet of [never, half]) {
      site.routes['/v0.3.3/app.asar'] = quiet;
      const { u, dir } = updater(site, { patience });
      assert.strictEqual((await u.check()).phase, 'available');
      const result = await u.install();
      assert.strictEqual(result.phase, 'error');
      assert.match(result.error, /went quiet/);
      assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing half-downloaded is left');
      // and the same click works once the server does
      site.routes['/v0.3.3/app.asar'] = asar;
      assert.strictEqual((await u.check()).phase, 'available');
      assert.strictEqual((await u.install()).phase, 'ready');
    }
    // a slow but steady download is not given up on: the limit is on silence, not on the total
    site.routes['/v0.3.3/app.asar'] = (req, res) => {
      res.writeHead(200);
      const parts = [asar.slice(0, 40000), asar.slice(40000, 80000), asar.slice(80000)];
      const send = () => { res.write(parts.shift()); if (parts.length) setTimeout(send, 150); else res.end(); };
      send();
    };
    const slow = updater(site, { patience });
    await slow.u.check();
    assert.strictEqual((await slow.u.install()).phase, 'ready');
  } finally {
    for (const res of hanging) res.destroy();
    await site.close();
  }
});

test('a server error or an unreachable server is reported in plain words', async () => {
  const site = await serve({ '/update.json': (req, res) => { res.writeHead(500); res.end('oops'); } });
  const { u } = updater(site);
  assert.match((await u.check()).error, /500/);
  await site.close();
  assert.match((await u.check()).error, /reach GitHub/);
});

test('a download redirected to a place that is not allowed is refused', async () => {
  const other = await serve(release('0.3.3').routes);
  const site = await serve({ '/update.json': (req, res) => { res.writeHead(302, { Location: `${other.base}/update.json` }); res.end(); } });
  try {
    const { u } = updater(site);
    const found = await u.check();
    assert.strictEqual(found.phase, 'error');
    assert.match(found.error, /redirected/);
  } finally { await site.close(); await other.close(); }
});

test('a version that failed to start before is offered again, flagged, and reinstalling clears the mark', async () => {
  const site = await serve(release('0.3.3').routes);
  try {
    const { u, dir } = updater(site);
    makePack(dir, '0.3.3', { files: { 'app.asar': 'broken', 'player/dl-player': 'x' } });
    packs.markBad(fs, dir, '0.3.3', 'threw');
    const found = await u.check();
    assert.strictEqual(found.phase, 'available');
    assert.strictEqual(found.failedBefore, true);
    assert.strictEqual(found.why, 'threw', 'with the reason it was set aside for');
    assert.strictEqual((await u.install()).phase, 'ready');
    assert.deepStrictEqual(packs.readState(fs, dir).bad, {});
    assert.strictEqual(fs.readFileSync(path.join(dir, '0.3.3', 'app.asar'), 'utf8'), FILES['app.asar']);
  } finally { await site.close(); }
});

test('a downloaded update the start-up code passed over at this start is reported, and is not "ready to restart into"', async () => {
  const site = await serve(release('0.3.3').routes);
  try {
    const skipped = [{ version: '0.3.1', why: 'the installed app is already at this version or later' }, { version: '0.3.3', why: 'player/dl-player is missing or incomplete' }];
    const { u, dir } = updater(site, { skipped });
    makePack(dir, '0.3.3', { files: FILES });
    fs.writeFileSync(path.join(dir, 'current.json'), '{"version":"0.3.3"}');
    assert.deepStrictEqual(u.view().passedOver, { version: '0.3.3', why: 'player/dl-player is missing or incomplete' });
    const found = await u.check();
    assert.strictEqual(found.phase, 'available', 'restarting again would end the same way: offer the download instead');
    // a fresh download in this run is a different matter
    assert.strictEqual((await u.install()).phase, 'ready');
    assert.strictEqual((await u.check()).phase, 'ready');
    // nothing to report when the only packs passed over are old ones
    assert.strictEqual(updater(site, { skipped: skipped.slice(0, 1) }).u.view().passedOver, null);
    assert.strictEqual(updater(site).u.view().passedOver, null);
  } finally { await site.close(); }
});

test('the window is told when this is the first start after an update', async () => {
  const site = await serve({});
  try {
    assert.strictEqual(updater(site, { version: '0.3.3', fresh: true }).u.view().fresh, true);
    assert.strictEqual(updater(site, { version: '0.3.3' }).u.view().fresh, false);
  } finally { await site.close(); }
});

test('a failure after the files are in place leaves nothing behind either', async () => {
  const site = await serve(release('0.3.3').routes);
  try {
    // the last step, noting which pack to start, can't be written
    const files = { ...fs, renameSync(from, to) { if (to.endsWith('current.json')) throw new Error('ENOSPC: no space left on device'); return fs.renameSync(from, to); } };
    const { u, dir } = updater(site, { files });
    await u.check();
    const result = await u.install();
    assert.strictEqual(result.phase, 'error');
    assert.match(result.error, /disk full/);
    assert.deepStrictEqual(fs.readdirSync(dir), ['state.json'], 'no pack, no pointer to one, no half-written file');
    assert.strictEqual(packs.choose({ fs, dir, bundledVersion: '0.3.2', electron: '45.2.3' }), null);
  } finally { await site.close(); }
});

test('errors are put in plain words', () => {
  assert.match(friendly(new Error('net::ERR_INTERNET_DISCONNECTED')), /reach GitHub/);
  assert.match(friendly(new Error('net::ERR_PROXY_CONNECTION_FAILED')), /reach GitHub/);
  assert.match(friendly(new TypeError('fetch failed')), /reach GitHub/);
  assert.match(friendly(new Error('net::ERR_CERT_AUTHORITY_INVALID')), /secure connection/);
  assert.match(friendly(new Error('ENOSPC: no space left on device, write')), /free space/);
  assert.match(friendly(new Error("EACCES: permission denied, mkdir '/x'")), /data folder/);
  assert.strictEqual(friendly(new Error('app.asar did not arrive intact. Try again.')), 'app.asar did not arrive intact. Try again.');
  assert.strictEqual(friendly('odd'), 'odd');
  // Trouble with the disk is not blamed on the network, and no path is shown.
  const disk = (code, text) => Object.assign(new Error(text), { code });
  assert.match(friendly(disk('ENOSPC', "ENOSPC: no space left on device, write '/Volumes/network share/x'")), /free space/);
  assert.match(friendly(disk('EROFS', "EROFS: read-only file system, open '/Users/me/My network/updates/x'")), /data folder/);
  assert.strictEqual(friendly(disk('ENOENT', "ENOENT: no such file or directory, rename '/Users/me/network/a' -> '/Users/me/b'")), 'The app could not save the update on this Mac (ENOENT). Try again.');
  assert.strictEqual(friendly(new Error("EIO: i/o error, write")), 'The app could not save the update on this Mac (EIO). Try again.');
  assert.match(friendly(new Error('Premature close')), /reach GitHub/);
  assert.strictEqual(friendly(new Error('The network folder is odd.')), 'The network folder is odd.');
});

test('two clicks on Update run one download', async () => {
  const site = await serve(release('0.3.3').routes);
  try {
    const { u } = updater(site);
    await u.check();
    const [a, b] = await Promise.all([u.install(), u.install()]);
    assert.strictEqual(a.phase, 'ready');
    assert.strictEqual(b.phase, 'ready');
    assert.strictEqual(site.hits['/v0.3.3/app.asar'], 1);
  } finally { await site.close(); }
});

test('tidy keeps the current and the last good pack, and forgets packs the installed app has caught up with', async () => {
  const site = await serve({});
  try {
    const { u, dir } = updater(site, { version: '0.3.5', bundledVersion: '0.3.2' });
    for (const v of ['0.3.3', '0.3.4', '0.3.5']) makePack(dir, v);
    fs.mkdirSync(path.join(dir, 'staging-0.3.6'));
    fs.writeFileSync(path.join(dir, 'current.json'), '{"version":"0.3.5"}');
    packs.noteGood(fs, dir, '0.3.4');
    u.tidy();
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['0.3.4', '0.3.5', 'current.json', 'state.json']);
    // the person installs 0.3.5 or later by hand: the packs are no longer needed
    const later = updater(site, { dir, version: '0.3.6', bundledVersion: '0.3.6' });
    later.u.tidy();
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['state.json']);
  } finally { await site.close(); }
});

test('a pack that was set aside is not "ready to restart into": it is offered again instead', async () => {
  const site = await serve(release('0.3.3').routes);
  try {
    const { u, dir } = updater(site);
    makePack(dir, '0.3.3', { files: FILES });
    fs.writeFileSync(path.join(dir, 'current.json'), '{"version":"0.3.3"}');
    assert.strictEqual((await u.check()).phase, 'ready', 'complete and waiting');
    packs.markBad(fs, dir, '0.3.3', 'threw');
    const found = await u.check();
    assert.strictEqual(found.phase, 'available');
    assert.strictEqual(found.failedBefore, true);
  } finally { await site.close(); }
});

test('tidy drops a pack that was set aside and points the next start back at the last good one', async () => {
  const site = await serve({});
  try {
    const { u, dir } = updater(site, { version: '0.3.3', bundledVersion: '0.3.2' });
    for (const v of ['0.3.3', '0.3.4']) makePack(dir, v);
    packs.noteGood(fs, dir, '0.3.3');
    fs.writeFileSync(path.join(dir, 'current.json'), '{"version":"0.3.4"}');
    packs.markBad(fs, dir, '0.3.4', 'threw');
    u.tidy();
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['0.3.3', 'current.json', 'state.json']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')), { version: '0.3.3' });
    assert.deepStrictEqual(Object.keys(packs.readState(fs, dir).bad), ['0.3.4'], 'the note about the failure stays');
    assert.strictEqual(packs.choose({ fs, dir, bundledVersion: '0.3.2', electron: '45.2.3' }).version, '0.3.3');
  } finally { await site.close(); }
});

test('tidy never removes the pack the app is running from', async () => {
  const site = await serve({});
  try {
    // running 0.3.4, but nothing on disk says so (its "it works" note could not be saved)
    const { u, dir } = updater(site, { version: '0.3.4', bundledVersion: '0.3.2' });
    for (const v of ['0.3.3', '0.3.4']) makePack(dir, v);
    u.tidy();
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['0.3.4']);
    // and the installed code leaves a waiting pack alone
    const plain = updater(site, { version: '0.3.2', bundledVersion: '0.3.2' });
    makePack(plain.dir, '0.3.3');
    fs.writeFileSync(path.join(plain.dir, 'current.json'), '{"version":"0.3.3"}');
    plain.u.tidy();
    assert.deepStrictEqual(fs.readdirSync(plain.dir).sort(), ['0.3.3', 'current.json']);
  } finally { await site.close(); }
});

test('tidy keeps out of the way of a download that is under way', async () => {
  const { routes } = release('0.3.3');
  const asar = routes['/v0.3.3/app.asar'];
  let tidied = false;
  let u;
  // tidy runs while the first file is half-way down
  routes['/v0.3.3/app.asar'] = (req, res) => {
    res.writeHead(200);
    res.write(asar.slice(0, 1000));
    setTimeout(() => { u.tidy(); tidied = true; res.end(asar.slice(1000)); }, 100);
  };
  const site = await serve(routes);
  try {
    u = updater(site).u;
    await u.check();
    assert.strictEqual((await u.install()).phase, 'ready');
    assert.ok(tidied);
  } finally { await site.close(); }
});

test('checks asked for at the same moment share one look, and a click during it waits for the answer', async () => {
  const site = await serve(release('0.3.3').routes);
  try {
    const { u } = updater(site);
    const [a, b] = await Promise.all([u.check(), u.check()]);
    assert.strictEqual(a.phase, 'available');
    assert.strictEqual(b.phase, 'available');
    assert.strictEqual(site.hits['/update.json'], 1);
    const second = updater(site).u;
    second.check(); // the look the app does by itself when it opens...
    assert.strictEqual((await second.install()).phase, 'ready', '...and a click on Update before it has answered');
  } finally { await site.close(); }
});
