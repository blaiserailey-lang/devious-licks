const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Library, folderSource } = require('../src/catalog');

const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');

function makeCatalog(games) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-cat-'));
  fs.mkdirSync(path.join(dir, 'roms'));
  const manifest = { games: [] };
  for (const g of games) {
    fs.writeFileSync(path.join(dir, 'roms', `${g.id}.nes`), g.data);
    manifest.games.push({ id: g.id, title: g.id, core: 'nes', rom: `roms/${g.id}.nes`, sha256: hash(g.data) });
  }
  fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify(manifest));
  return dir;
}

test('refresh adds, updates, keeps and removes games', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-lib-'));
  let cat = makeCatalog([{ id: 'one', data: 'A' }, { id: 'two', data: 'B' }]);
  let lib = new Library(cache, folderSource(cat));
  await lib.load();
  let r = await lib.refresh();
  assert.deepStrictEqual(r.summary.added, ['one', 'two']);
  assert.ok(r.games.every((g) => g.status === null), 'no badges on first sync');

  cat = makeCatalog([{ id: 'one', data: 'A2' }, { id: 'three', data: 'C' }]);
  lib = new Library(cache, folderSource(cat)); // simulates app restart
  await lib.load();
  r = await lib.refresh();
  assert.deepStrictEqual(r.summary.updated, ['one']);
  assert.deepStrictEqual(r.summary.added, ['three']);
  assert.deepStrictEqual(r.summary.removed, ['two']);
  assert.strictEqual(r.games.find((g) => g.id === 'one').status, 'updated');
  assert.strictEqual(r.games.find((g) => g.id === 'three').status, 'new');
  assert.strictEqual(fs.readFileSync(path.join(cache, 'roms', 'one.nes'), 'utf8'), 'A2');
  assert.ok(!fs.existsSync(path.join(cache, 'roms', 'two.nes')));

  r = await lib.refresh();
  assert.deepStrictEqual([r.summary.added, r.summary.updated, r.summary.removed], [[], [], []]);
});

test('a corrupted download keeps the last good copy', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-lib-'));
  const cat = makeCatalog([{ id: 'one', data: 'A' }]);
  const lib = new Library(cache, folderSource(cat));
  await lib.load();
  await lib.refresh();
  const m = JSON.parse(fs.readFileSync(path.join(cat, 'games.json')));
  m.games[0].sha256 = 'deadbeef';
  fs.writeFileSync(path.join(cat, 'games.json'), JSON.stringify(m));
  const r = await lib.refresh();
  assert.strictEqual(r.summary.failed.length, 1);
  assert.strictEqual(r.games.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(cache, 'roms', 'one.nes'), 'utf8'), 'A');
});

test('the real catalog is valid', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'games.json')));
  for (const g of m.games) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'catalog', g.rom)), g.rom);
    assert.strictEqual(hash(fs.readFileSync(path.join(__dirname, '..', 'catalog', g.rom))), g.sha256, `${g.id} sha256 is stale: run npm run catalog`);
  }
});

test('games.json without hashes does not mark games updated every refresh', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-lib-'));
  const cat = makeCatalog([{ id: 'one', data: 'A' }]);
  const m = JSON.parse(fs.readFileSync(path.join(cat, 'games.json')));
  delete m.games[0].sha256;
  fs.writeFileSync(path.join(cat, 'games.json'), JSON.stringify(m));
  const lib = new Library(cache, folderSource(cat));
  await lib.load();
  await lib.refresh();
  let r = await lib.refresh();
  assert.deepStrictEqual(r.summary.updated, []);
  fs.writeFileSync(path.join(cat, 'roms', 'one.nes'), 'A3');
  r = await lib.refresh();
  assert.deepStrictEqual(r.summary.updated, ['one']);
});

test('a catalog entry can never name a file outside the library folder', async () => {
  const dir = makeCatalog([{ id: 'good', data: 'A' }]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'games.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'roms', 'x.asar'), 'not a game');
  const hostile = [
    { id: '../../updates/9.9.9/app', title: 'x', core: 'nes', rom: 'roms/x.asar' },
    { id: '..', title: 'x', core: 'nes', rom: 'roms/x.asar' },
    { id: 'a/b', title: 'x', core: 'nes', rom: 'roms/x.asar' },
    { id: 'Upper', title: 'x', core: 'nes', rom: 'roms/x.asar' },
    { id: 'fine-id', title: 'x', core: 'nes', rom: '../outside.nes' },
    { id: 'fine-id2', title: 'x', core: 'nes', rom: 'roms/../../outside.nes' },
    { id: 'fine-id3', title: 'x', core: 'nes', rom: '/etc/hosts' },
    { id: 7, title: 'x', core: 'nes', rom: 'roms/x.asar' },
    { id: 'good', title: 'the same id twice', core: 'nes', rom: 'roms/x.asar' },
    null, 'text', [],
  ];
  fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify({ studio: { odd: true }, games: [...manifest.games, ...hostile] }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-lib-'));
  const lib = new Library(path.join(home, 'library'), folderSource(dir));
  await lib.load();
  const r = await lib.refresh();
  assert.deepStrictEqual(r.games.map((g) => g.id), ['good']);
  assert.match(r.summary.failed.join('\n'), /12 catalog entries are not valid/);
  assert.deepStrictEqual(fs.readdirSync(home), ['library'], 'nothing was written next to the library folder');
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'library', 'roms')), ['good.nes']);
  // A cover is only fetched from inside the catalog folder, too.
  fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify({ games: [{ ...manifest.games[0], cover: '../../secret.png' }] }));
  assert.strictEqual((await lib.refresh()).games[0].cover, null);
});

test('a saved library this version cannot read is rebuilt, and never leads outside the folder', async () => {
  const dir = makeCatalog([{ id: 'good', data: 'A' }]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-lib-'));
  const libDir = path.join(home, 'library');
  fs.mkdirSync(libDir);
  fs.writeFileSync(path.join(home, 'precious.txt'), 'keep me');
  for (const saved of [
    '{"version":2,"games":{"good":{}}}', '[]', '"x"', '{', '{"games":[null,7,{"id":"good"}]}',
    JSON.stringify({ syncedAt: 5, games: [{ id: 'gone', title: 'Gone', core: 'nes', romFile: '../../precious.txt', coverFile: '../../precious.txt' }] }),
  ]) {
    fs.writeFileSync(path.join(libDir, 'library.json'), saved);
    const lib = new Library(libDir, folderSource(dir));
    assert.deepStrictEqual((await lib.load()).games, [], saved);
    assert.deepStrictEqual((await lib.refresh()).games.map((g) => g.id), ['good'], saved);
    assert.strictEqual(fs.readFileSync(path.join(home, 'precious.txt'), 'utf8'), 'keep me', saved);
  }
});
