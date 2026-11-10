const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const packs = require('../src/packs');
const { Updater } = require('../src/updater');
const { tmp, describe, makePack, serve } = require('./helpers');

const FILES = { 'app.asar': 'the app, version 0.3.3 '.repeat(5000), 'player/dl-player': 'player v2', 'player/core.dylib': 'core v1' };

// A release on the pretend GitHub: update.json plus the files it lists.
function release(version, files = FILES, extra = {}) {
  const manifest = describe(version, files, extra);
  const routes = { '/update.json': JSON.stringify(manifest) };
  for (const [to, body] of Object.entries(files)) routes[`/v${version}/${path.basename(to)}`] = body;
  return { manifest, routes };
}

function updater(site, { dir = tmp('dl-upd-'), version = '0.3.2', bundledVersion = '0.3.2', electron = '45.2.3', places = [], allowed } = {}) {
  const changes = [];
  const u = new Updater({
    fs, fetch, dir,
    feed: `${site.base}/update.json`,
    fileUrl: (v, name) => `${site.base}/v${v}/${name}`,
    allowed: allowed || ((url) => url.startsWith(site.base)),
    running: { version, bundledVersion, electron, places },
    onChange: (view) => changes.push(view),
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

test('no update information published (404): up to date, not an error', async () => {
  const site = await serve({});
  try {
    assert.strictEqual((await updater(site).u.check()).phase, 'none');
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
  for (const [extra, running] of [
    [{ electron: '46.0.0' }, {}],
    [{ needsApp: '0.4.0' }, {}],
    [{ needsApp: '0.3.3' }, { version: '0.3.4', bundledVersion: '0.3.2' }], // running a pack on an old installed app
  ]) {
    const site = await serve(release('0.5.0', FILES, extra).routes);
    try {
      const { u, dir } = updater(site, running);
      const found = await u.check();
      assert.strictEqual(found.phase, 'download', JSON.stringify(extra));
      assert.strictEqual(found.latest, '0.5.0');
      assert.strictEqual((await u.install()).phase, 'download', 'install does nothing');
      assert.ok(!fs.existsSync(path.join(dir, '0.5.0')));
    } finally { await site.close(); }
  }
  const site = await serve({ '/update.json': JSON.stringify({ format: 2, version: '1.0.0', shape: 'unknown' }) });
  try {
    assert.strictEqual((await updater(site).u.check()).phase, 'download');
  } finally { await site.close(); }
});

test('bad update information is an error, never an install', async () => {
  for (const body of ['not json', '{"format":1}', JSON.stringify({ ...describe('0.3.3', FILES), files: [{ name: 'x', to: '../x', size: 1, sha256: 'a'.repeat(64) }] }), 'x'.repeat(200000)]) {
    const site = await serve({ '/update.json': body });
    try {
      const { u, dir } = updater(site);
      const found = await u.check();
      assert.strictEqual(found.phase, 'error', body.slice(0, 30));
      assert.ok(found.error.length > 0);
      assert.deepStrictEqual(fs.readdirSync(dir), []);
    } finally { await site.close(); }
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
    assert.strictEqual((await u.install()).phase, 'ready');
    assert.deepStrictEqual(packs.readState(fs, dir).bad, {});
    assert.strictEqual(fs.readFileSync(path.join(dir, '0.3.3', 'app.asar'), 'utf8'), FILES['app.asar']);
  } finally { await site.close(); }
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
