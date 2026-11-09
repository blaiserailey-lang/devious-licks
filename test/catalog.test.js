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
