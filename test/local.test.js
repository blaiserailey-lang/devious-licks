const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalGames } = require('../src/local');

test('adds, dedupes and removes local games', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-src-'));
  fs.writeFileSync(path.join(src, 'My_Game.z64'), 'n64data');
  fs.writeFileSync(path.join(src, 'notes.txt'), 'x');
  const lib = new LocalGames(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-local-')));
  await lib.load();
  let r = await lib.add([path.join(src, 'My_Game.z64'), path.join(src, 'notes.txt')]);
  assert.deepStrictEqual(r.added, ['My Game']);
  assert.strictEqual(r.skipped.length, 1);
  assert.strictEqual(lib.games[0].core, 'n64');
  r = await lib.add([path.join(src, 'My_Game.z64')]);
  assert.deepStrictEqual(r.added, []);
  const again = new LocalGames(lib.dir);
  await again.load();
  assert.strictEqual(again.view()[0].local, true);
  await again.remove(again.games[0].id);
  assert.strictEqual(again.games.length, 0);
  assert.strictEqual(fs.readdirSync(lib.dir).filter((f) => f.endsWith('.z64')).length, 0);
});

test('a list of local games kept by a later version is never written over', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-src-'));
  fs.writeFileSync(path.join(src, 'New.nes'), 'nesdata');
  const entry = { id: 'local-aaaaaaaaaaaa', title: 'Old', core: 'n64', romFile: 'local-aaaaaaaaaaaa.z64', sha256: 'a'.repeat(64) };
  const later = { id: 'local-bbbbbbbbbbbb', name: { en: 'Later' }, file: { path: 'x' } }; // a shape this version doesn't know

  // A list wrapped in an object is read, and written back with its wrapper and the entries it can't use.
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-local-'));
  fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify({ version: 2, sort: 'title', games: [entry, later] }));
  let lib = new LocalGames(dir);
  await lib.load();
  assert.deepStrictEqual(lib.view().map((g) => g.title), ['Old']);
  await lib.add([path.join(src, 'New.nes')]);
  let saved = JSON.parse(fs.readFileSync(path.join(dir, 'local.json'), 'utf8'));
  assert.deepStrictEqual([saved.version, saved.sort, saved.games.length], [2, 'title', 3]);
  assert.deepStrictEqual(saved.games[2], later);

  // A file it can't make sense of gives an empty library, and is moved aside before anything is saved.
  for (const odd of ['{"version":3,"byId":{}}', '"text"', '{', '7']) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-local-'));
    fs.writeFileSync(path.join(dir, 'local.json'), odd);
    lib = new LocalGames(dir);
    await lib.load();
    assert.deepStrictEqual(lib.view(), [], odd);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'local.json'), 'utf8'), odd, 'loading changes nothing');
    await lib.add([path.join(src, 'New.nes')]);
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith('local.json.unreadable-'));
    assert.strictEqual(kept.length, 1, odd);
    assert.strictEqual(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), odd);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'local.json'), 'utf8')).length, 1);
  }

  // An entry whose file name leads elsewhere is not a game.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-local-'));
  fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify([{ ...entry, romFile: '../../outside.z64' }, entry]));
  lib = new LocalGames(dir);
  await lib.load();
  assert.deepStrictEqual(lib.games.map((g) => g.romFile), ['local-aaaaaaaaaaaa.z64']);
});

test('one file that cannot be read does not cost the others their place in the list', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-src-'));
  fs.writeFileSync(path.join(src, 'Kept.nes'), 'nesdata');
  fs.mkdirSync(path.join(src, 'Folder.z64')); // reading it fails with EISDIR
  const lib = new LocalGames(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-local-')));
  await lib.load();
  const r = await lib.add([path.join(src, 'Kept.nes'), path.join(src, 'Folder.z64'), path.join(src, 'Gone.gba')]);
  assert.deepStrictEqual(r.added, ['Kept']);
  assert.strictEqual(r.skipped.length, 2);
  assert.match(r.skipped[0], /Folder\.z64: could not be read \(EISDIR\)/);
  const again = new LocalGames(lib.dir);
  await again.load();
  assert.deepStrictEqual(again.view().map((g) => g.title), ['Kept']);
});
