const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const packs = require('../src/packs');

const { tmp: makeTmp, makePack } = require('./helpers');
const tmp = () => makeTmp('dl-packs-');
const current = (dir, version) => fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ version }));
const choose = (dir, bundledVersion = '0.3.2', electron = '45.2.3') => packs.choose({ fs, dir, bundledVersion, electron });

test('versions compare by number, and only real versions count', () => {
  assert.ok(packs.newer('0.3.10', '0.3.9'));
  assert.ok(packs.newer('1.0.0', '0.99.99'));
  assert.ok(!packs.newer('0.3.2', '0.3.2'));
  assert.ok(!packs.newer('0.3.1', '0.3.2'));
  for (const odd of ['', '1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '01.2.3', '1.2.3-beta', null, undefined, 123, {}]) {
    assert.ok(!packs.newer(odd, '0.0.1'), `${odd} is not a version`);
    assert.ok(!packs.newer('9.9.9', odd), `${odd} is not a version`);
  }
});

test('a file may only land inside the pack folder', () => {
  for (const fine of ['app.asar', 'player/dl-player', 'a/b/c/d/e/f/g/h', 'cores/N64 (v2)/libretro+gl@1,2=x~.dylib', `${'n'.repeat(100)}`, 'X.framework/_CodeSignature/CodeResources', '__init__.py']) {
    assert.strictEqual(packs.safeTarget(fine), fine);
  }
  for (const odd of [
    '../x', '/etc/passwd', 'a//b', 'a/./b', 'a/../b', '..', '.hidden', 'a/.hidden', '-rf', '~x', ' x', 'a\\b', 'a:b', 'a\nb', 'a\0b',
    'x.', 'x ', 'a /b', 'a./b', '', 'ünï', 'a/'.repeat(2), 'a/b/c/d/e/f/g/h/i', 'n'.repeat(101), 7, null, ['app.asar'],
  ]) {
    assert.strictEqual(packs.safeTarget(odd), null, `${JSON.stringify(odd)} must be refused`);
  }
});

test('update information is checked field by field', () => {
  const good = {
    format: 1, version: '0.3.3', electron: '45.2.3', needsApp: '0.3.2', notes: 'Line one\nLine two',
    files: [
      { name: 'app.asar', to: 'app.asar', size: 10, sha256: 'a'.repeat(64) },
      { name: 'dl-player', to: 'player/dl-player', size: 5, sha256: 'b'.repeat(64), exec: true },
    ],
  };
  const clean = packs.checkManifest(good);
  assert.strictEqual(clean.version, '0.3.3');
  assert.strictEqual(clean.files[1].exec, true);
  assert.strictEqual(clean.files[0].exec, false);
  const broken = (change) => {
    const copy = JSON.parse(JSON.stringify(good));
    change(copy);
    assert.throws(() => packs.checkManifest(copy), /not valid/);
  };
  broken((m) => { m.version = '0.3'; });
  broken((m) => { m.format = 0; });
  broken((m) => { m.format = '1'; });
  broken((m) => { m.electron = 'latest'; });
  broken((m) => { m.needsApp = 'x'; });
  broken((m) => { m.files = []; });
  broken((m) => { m.files = 'app.asar'; });
  broken((m) => { m.files[0].to = '../../main.js'; });
  broken((m) => { m.files[1].to = 'app.asar'; });
  broken((m) => { m.files[1].to = 'APP.ASAR'; });
  broken((m) => { m.files[1].to = 'pack.json'; });        // the pack's own description lives there
  broken((m) => { m.files[1].to = 'Pack.json'; });
  broken((m) => { m.files[1].to = 'app.asar/inside'; });  // a file can't also be a folder
  broken((m) => { m.files.push({ name: 'x', to: 'player', size: 1, sha256: 'c'.repeat(64) }); });
  broken((m) => { m.files.unshift({ name: 'x', to: 'PLAYER', size: 1, sha256: 'c'.repeat(64) }); });
  broken((m) => { m.files[0].name = 'a/b'; });
  broken((m) => { m.files[0].name = 'a b'; });             // a release file's name stays plain
  broken((m) => { m.files[0].size = 0; });
  broken((m) => { m.files[0].size = 1e12; });
  broken((m) => { m.files[0].size = 2 * 1024 * 1024 * 1024 + 1; });
  broken((m) => { m.files = Array.from({ length: 501 }, (_, i) => ({ name: `f${i}`, to: i ? `f${i}` : 'app.asar', size: 1, sha256: 'a'.repeat(64) })); });
  broken((m) => { m.files[0].size = 1.5; });
  broken((m) => { m.files[0].sha256 = 'A'.repeat(64); });
  broken((m) => { m.files.shift(); }); // no app.asar
  for (const odd of [null, [], 'x', 5]) assert.throws(() => packs.checkManifest(odd), /not valid/);
  // a later format is only known to be "not for this app"
  assert.deepStrictEqual(packs.checkManifest({ format: 2, version: '1.0.0', anything: true }), { format: 2, version: '1.0.0' });
  // notes are plain text
  assert.strictEqual(packs.checkManifest({ ...good, notes: 'a\u0007b<‮' }).notes, 'a b<');
  // room for later versions: many files, big files, folders several levels deep, anything unknown is ignored
  const roomy = packs.checkManifest({
    ...good,
    later: { anything: true },
    files: [
      ...good.files.map((f) => ({ ...f, later: 1 })),
      { name: 'core.dylib', to: 'cores/n64/v2/core.dylib', size: 2 * 1024 * 1024 * 1024, sha256: 'c'.repeat(64) },
      ...Array.from({ length: 497 }, (_, i) => ({ name: `f${i}`, to: `data/set ${i}/f${i}.bin`, size: 1, sha256: 'd'.repeat(64) })),
    ],
  });
  assert.strictEqual(roomy.files.length, 500);
  assert.deepStrictEqual(Object.keys(roomy), ['format', 'version', 'electron', 'needsApp', 'notes', 'files']);
  assert.deepStrictEqual(Object.keys(roomy.files[0]), ['name', 'to', 'size', 'sha256', 'exec']);
});

test('the engine has to be the same major version, not the same build', () => {
  assert.ok(packs.sameEngine('45.2.3', '45.2.3'));
  assert.ok(packs.sameEngine('45.9.0', '45.2.3'));
  assert.ok(packs.sameEngine('45.0.0', '45.2.3-beta.1'));
  for (const [a, b] of [['46.0.0', '45.2.3'], ['4.5.0', '45.0.0'], ['45', '45.2.3'], ['', '45.2.3'], [undefined, undefined], [null, '45.2.3'], ['x.1.2', 'x.1.2']]) {
    assert.ok(!packs.sameEngine(a, b), `${a} / ${b}`);
  }
});

test('an update still on the server can be asked about before it is downloaded', () => {
  const info = {
    format: 1, version: '0.3.3', electron: '45.4.0', needsApp: '0.3.2',
    files: [{ name: 'app.asar', to: 'app.asar', size: 10, sha256: 'a'.repeat(64) }],
  };
  const ask = (change = {}, app = {}) => packs.accepts({ info: { ...info, ...change }, electron: '45.2.3', bundledVersion: '0.3.2', ...app });
  assert.strictEqual(ask(), '');
  assert.match(ask({ electron: '46.0.0' }), /engine 46\.0\.0/);
  assert.match(ask({ needsApp: '0.3.3' }), /0\.3\.3 or later/);
  assert.match(ask({ format: 2 }), /later format/);
  assert.match(ask({ files: [] }), /damaged, or too new/);
  assert.match(ask({ version: '0.3.2' }), /already at this version/);
  assert.match(ask({}, { bundledVersion: '0.4.0' }), /already at this version/);
  for (const odd of [null, 'x', [], 7]) assert.match(packs.accepts({ info: odd, electron: '45.2.3', bundledVersion: '0.3.2' }), /damaged, or too new/);
});

test('no pack: the installed code runs', () => {
  const dir = tmp();
  assert.strictEqual(choose(dir), null);
  assert.strictEqual(choose(path.join(dir, 'missing')), null);
});

test('a complete, newer pack for this engine is chosen', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  current(dir, '0.3.3');
  const pack = choose(dir);
  assert.strictEqual(pack.version, '0.3.3');
  assert.strictEqual(pack.dir, path.join(dir, '0.3.3'));
});

test('a pack is passed over when it is not newer, not for this engine, or not whole', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  current(dir, '0.3.3');
  assert.strictEqual(choose(dir, '0.3.3'), null, 'same version as the installed app');
  assert.strictEqual(choose(dir, '0.4.0'), null, 'older than the installed app');
  assert.strictEqual(choose(dir, '0.3.2', '46.0.0'), null, 'built for another engine');
  assert.strictEqual(choose(dir, '0.3.2', '45.0.1').version, '0.3.3', 'a different build of the same engine is fine');
  fs.writeFileSync(path.join(dir, '0.3.3', 'app.asar'), 'short');
  assert.strictEqual(choose(dir), null, 'a file with the wrong size');
  makePack(dir, '0.3.3');
  fs.rmSync(path.join(dir, '0.3.3', 'player', 'dl-player'));
  assert.strictEqual(choose(dir), null, 'a missing file');
  makePack(dir, '0.3.3');
  fs.writeFileSync(path.join(dir, '0.3.3', 'pack.json'), '{ not json');
  assert.strictEqual(choose(dir), null, 'a damaged description');
  makePack(dir, '0.3.3');
  assert.ok(choose(dir), 'whole again');
  for (const junk of ['', 'null', '[]', '{"version":"../../x"}', '{"version":7}']) {
    fs.writeFileSync(path.join(dir, 'current.json'), junk);
    assert.strictEqual(choose(dir), null, `current.json = ${junk}`);
  }
});

test('three failed starts in a row set a pack aside, and the last good one takes over', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  makePack(dir, '0.3.4');
  current(dir, '0.3.3');
  packs.noteStart(fs, dir, '0.3.3');
  packs.noteGood(fs, dir, '0.3.3');
  current(dir, '0.3.4');
  for (let i = 0; i < packs.MAX_STARTS; i++) {
    assert.strictEqual(choose(dir).version, '0.3.4', `start ${i + 1}`);
    packs.noteStart(fs, dir, '0.3.4');
  }
  assert.strictEqual(choose(dir).version, '0.3.3', 'back to the last good pack');
  assert.ok(packs.readState(fs, dir).bad['0.3.4']);
  assert.match(packs.readState(fs, dir).bad['0.3.4'], /3 starts in a row/);
  // a start that came up clears the count
  packs.clearBad(fs, dir, '0.3.4');
  packs.noteStart(fs, dir, '0.3.4');
  packs.noteStart(fs, dir, '0.3.4');
  packs.noteGood(fs, dir, '0.3.4');
  assert.deepStrictEqual(packs.readState(fs, dir).starts, {});
  assert.strictEqual(choose(dir).version, '0.3.4');
});

test('a start that proves nothing can be taken back off the count', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  current(dir, '0.3.3');
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(choose(dir).version, '0.3.3', `start ${i + 1}`);
    assert.ok(packs.noteStart(fs, dir, '0.3.3'));
    assert.ok(packs.unnoteStart(fs, dir, '0.3.3')); // a second copy of the app that handed over and quit
  }
  assert.deepStrictEqual(packs.readState(fs, dir).starts, {});
  packs.noteStart(fs, dir, '0.3.3');
  packs.noteStart(fs, dir, '0.3.3');
  packs.unnoteStart(fs, dir, '0.3.3');
  assert.deepStrictEqual(packs.readState(fs, dir).starts, { '0.3.3': 1 });
  packs.unnoteStart(fs, dir, '0.3.3');
  packs.unnoteStart(fs, dir, '0.3.3'); // never below nothing
  assert.deepStrictEqual(packs.readState(fs, dir).starts, {});
});

test('notes a later version keeps in the state file survive this one writing to it', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ good: '0.3.3', starts: {}, bad: {}, later: { tries: 2 }, channel: 'beta' }));
  packs.noteStart(fs, dir, '0.3.4');
  packs.unnoteStart(fs, dir, '0.3.4');
  packs.noteStart(fs, dir, '0.3.4');
  packs.noteGood(fs, dir, '0.3.4');
  packs.markBad(fs, dir, '0.3.5', 'threw');
  packs.clearBad(fs, dir, '0.3.5');
  packs.forget(fs, dir, '0.3.3');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), { good: '0.3.4', starts: {}, bad: {}, later: { tries: 2 }, channel: 'beta' });
  assert.deepStrictEqual(fs.readdirSync(dir), ['state.json'], 'no half-written file is left behind');
});

test('a pack marked bad is not chosen, and without a good one the installed code runs', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  current(dir, '0.3.3');
  packs.noteStart(fs, dir, '0.3.3');
  packs.noteGood(fs, dir, '0.3.3');
  assert.ok(packs.markBad(fs, dir, '0.3.3', 'threw'));
  assert.strictEqual(choose(dir), null);
  assert.strictEqual(packs.readState(fs, dir).good, null);
  packs.clearBad(fs, dir, '0.3.3');
  assert.strictEqual(choose(dir).version, '0.3.3');
});

test('a damaged state file counts as empty', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  current(dir, '0.3.3');
  for (const junk of ['{', '[]', '"x"', '{"starts":[],"bad":7,"good":"nope"}', '{"starts":{"0.3.3":"many"}}']) {
    fs.writeFileSync(path.join(dir, 'state.json'), junk);
    assert.strictEqual(choose(dir).version, '0.3.3', junk);
  }
});

test('the code file has to be spelled app.asar, exactly', () => {
  const file = (to) => ({ name: 'app.asar', to, size: 10, sha256: 'a'.repeat(64) });
  const info = (to) => ({ format: 1, version: '0.3.3', electron: '45.2.3', files: [file(to)] });
  assert.strictEqual(packs.checkManifest(info('app.asar')).files[0].to, 'app.asar');
  for (const odd of ['App.asar', 'APP.ASAR', 'app.Asar', 'sub/app.asar']) assert.throws(() => packs.checkManifest(info(odd)), /no app\.asar/, odd);
});

test('a pack that reports in as working is no longer set aside', () => {
  // (a second copy of the app, started while the first was on its third try, can note it as bad)
  const dir = tmp();
  makePack(dir, '0.3.3');
  current(dir, '0.3.3');
  for (let n = 0; n < 3; n++) assert.ok(packs.noteStart(fs, dir, '0.3.3'));
  assert.strictEqual(choose(dir), null, 'the second copy passes it over');
  assert.ok(packs.isBad(packs.readState(fs, dir), '0.3.3'));
  assert.ok(packs.noteGood(fs, dir, '0.3.3'), 'the first copy comes up');
  assert.deepStrictEqual(packs.readState(fs, dir), { good: '0.3.3', starts: {}, bad: {} });
  assert.strictEqual(choose(dir).version, '0.3.3');
});

test('a start count that is not a count is read as none, and the next start counts from one', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  current(dir, '0.3.3');
  for (const odd of ['"3"', '"many"', '-7', '2.5', '1e400', 'true', 'null', '[3]', '{"n":3}']) {
    fs.writeFileSync(path.join(dir, 'state.json'), `{"starts":{"0.3.3":${odd}}}`);
    assert.strictEqual(choose(dir).version, '0.3.3', odd);
    assert.ok(packs.noteStart(fs, dir, '0.3.3'));
    assert.deepStrictEqual(packs.readState(fs, dir).starts, { '0.3.3': 1 }, odd);
    fs.writeFileSync(path.join(dir, 'state.json'), `{"starts":{"0.3.3":${odd}}}`);
    assert.ok(packs.unnoteStart(fs, dir, '0.3.3'));
    assert.deepStrictEqual(packs.readState(fs, dir).starts, {}, odd);
  }
  // A real count still counts, however large.
  fs.writeFileSync(path.join(dir, 'state.json'), '{"starts":{"0.3.3":4000000}}');
  assert.strictEqual(choose(dir), null);
  assert.match(packs.readState(fs, dir).bad['0.3.3'], /3 starts in a row/);
});

test('tidy removes old packs and leftovers, and nothing else', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  makePack(dir, '0.3.4');
  makePack(dir, '0.3.5');
  fs.mkdirSync(path.join(dir, 'staging-0.3.6'));
  fs.writeFileSync(path.join(dir, 'state.json.tmp'), 'x');
  fs.writeFileSync(path.join(dir, 'current.json.4242.tmp'), 'x');
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  fs.writeFileSync(path.join(dir, 'current.json'), '{"version":"0.3.5"}');
  fs.mkdirSync(path.join(dir, 'something-else'));
  packs.tidy(fs, dir, ['0.3.5', '0.3.4']);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['0.3.4', '0.3.5', 'current.json', 'something-else', 'state.json']);
  packs.tidy(fs, path.join(dir, 'missing')); // nothing to do, no error
});


test('forget drops the notes about versions the installed app has caught up with', () => {
  const dir = tmp();
  packs.noteGood(fs, dir, '0.3.3');
  packs.markBad(fs, dir, '0.3.4', 'threw');
  packs.markBad(fs, dir, '0.3.6', 'threw');
  packs.noteStart(fs, dir, '0.3.5');
  packs.forget(fs, dir, '0.3.2');
  assert.deepStrictEqual(packs.readState(fs, dir), { good: '0.3.3', starts: { '0.3.5': 1 }, bad: { '0.3.4': 'threw', '0.3.6': 'threw' } });
  packs.forget(fs, dir, '0.3.5'); // the person installed 0.3.5 by hand
  assert.deepStrictEqual(packs.readState(fs, dir), { good: null, starts: {}, bad: { '0.3.6': 'threw' } });
  assert.strictEqual(packs.isBad(packs.readState(fs, dir), '0.3.6'), true);
  assert.strictEqual(packs.isBad(packs.readState(fs, dir), '0.3.4'), false);
  assert.strictEqual(packs.isBad(packs.readState(fs, dir), 'constructor'), false);
});

test('a pack that needs a newer installed app than this one is not started', () => {
  const dir = tmp();
  const manifest = makePack(dir, '0.5.0');
  fs.writeFileSync(path.join(dir, '0.5.0', 'pack.json'), JSON.stringify({ ...manifest, needsApp: '0.4.0' }));
  current(dir, '0.5.0');
  assert.strictEqual(choose(dir, '0.3.2'), null, 'installed app 0.3.2 is too old for it');
  assert.strictEqual(choose(dir, '0.4.0').version, '0.5.0');
  assert.match(packs.inspect({ fs, dir, version: '0.5.0', electron: '45.2.3', bundledVersion: '0.3.9' }), /0\.4\.0 or later/);
});

test('a pack is not started when its start cannot be counted', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  current(dir, '0.3.3');
  assert.strictEqual(packs.noteStart(fs, dir, '0.3.3'), true);
  // the same call against a place that can't be written reports it (boot.js then runs the installed code)
  const readOnly = { ...fs, writeFileSync() { throw new Error('EROFS'); } };
  assert.strictEqual(packs.noteStart(readOnly, dir, '0.3.3'), false);
});

test('choose says which packs it passed over, and why', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  makePack(dir, '0.3.4', { electron: '46.0.0' });
  packs.noteGood(fs, dir, '0.3.3');
  current(dir, '0.3.4');
  const skipped = [];
  assert.strictEqual(packs.choose({ fs, dir, bundledVersion: '0.3.2', electron: '45.2.3', skipped }).version, '0.3.3');
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].version, '0.3.4');
  assert.match(skipped[0].why, /engine 46\.0\.0/);
  // set aside, and caught up with by the installed app
  packs.markBad(fs, dir, '0.3.4', 'threw');
  const again = [];
  assert.strictEqual(packs.choose({ fs, dir, bundledVersion: '0.3.3', electron: '45.2.3', skipped: again }), null);
  assert.deepStrictEqual(again.map((s) => s.version), ['0.3.4', '0.3.3']);
  assert.match(again[0].why, /set aside: threw/);
  assert.match(again[1].why, /already at this version/);
  // and it still works without a list to fill
  assert.strictEqual(choose(dir, '0.3.2').version, '0.3.3');
});

test('a reason for setting a pack aside that is not text does not stop the choice', () => {
  const dir = tmp();
  makePack(dir, '0.3.3');
  current(dir, '0.3.3');
  // (Written by hand, or by something else: a value that cannot even be turned into text.)
  fs.writeFileSync(path.join(dir, 'state.json'), '{"good":null,"starts":{},"bad":{"0.3.3":{"toString":1}}}');
  const skipped = [];
  assert.strictEqual(packs.choose({ fs, dir, bundledVersion: '0.3.2', electron: '45.2.3', skipped }), null);
  assert.match(skipped.map((s) => s.why).join('\n'), /set aside: no reason noted/);
});
