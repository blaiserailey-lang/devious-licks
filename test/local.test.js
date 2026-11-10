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

test('a zipped game is turned away with a word on what to do', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-src-'));
  fs.writeFileSync(path.join(src, 'Game.zip'), 'PK');
  const lib = new LocalGames(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-local-')));
  await lib.load();
  const r = await lib.add([path.join(src, 'Game.zip')]);
  assert.deepStrictEqual(r.added, []);
  assert.match(r.skipped[0], /Game\.zip: unpack it first/);
});

// ---- pictures for added games ----
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest of a jpeg')]);

async function withOneGame() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-src-'));
  fs.writeFileSync(path.join(src, 'Hoops.z64'), 'n64data');
  const lib = new LocalGames(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-local-')));
  await lib.load();
  await lib.add([path.join(src, 'Hoops.z64')]);
  return { src, lib, id: lib.games[0].id };
}

test('a game added from a file can be given a picture, a new one replaces it, and removing the game removes it', async () => {
  const { src, lib, id } = await withOneGame();
  assert.strictEqual(lib.view()[0].cover, null);
  fs.writeFileSync(path.join(src, 'Box Art.PNG'), PNG);
  let r = await lib.setCover(id, path.join(src, 'Box Art.PNG'));
  assert.deepStrictEqual([r.ok, r.message], [true, 'Hoops has its picture']);
  const first = lib.games[0].coverFile;
  assert.match(first, /^local-[0-9a-f]{12}\.cover-[0-9a-f]{8}\.png$/);
  assert.deepStrictEqual(fs.readFileSync(path.join(lib.dir, first)), PNG);
  assert.strictEqual(lib.view()[0].cover, `app://local/${first}`);
  // It is in the list for the next start...
  const again = new LocalGames(lib.dir);
  await again.load();
  assert.strictEqual(again.coverOf(again.games[0]), first);
  // ...a file named .png that is really a JPEG is kept as what it is...
  fs.writeFileSync(path.join(src, 'other.png'), JPG);
  r = await again.setCover(id, path.join(src, 'other.png'));
  assert.strictEqual(r.ok, true);
  const second = again.games[0].coverFile;
  assert.match(second, /\.jpg$/);
  assert.deepStrictEqual(fs.readdirSync(again.dir).filter((f) => f.includes('.cover-')), [second]); // ...and the old picture is gone.
  await again.remove(id);
  assert.deepStrictEqual(fs.readdirSync(again.dir).filter((f) => f !== 'local.json'), []);
});

test('what is not a picture is turned away, and the game keeps what it had', async () => {
  const { src, lib, id } = await withOneGame();
  fs.writeFileSync(path.join(src, 'good.png'), PNG);
  await lib.setCover(id, path.join(src, 'good.png'));
  const kept = lib.games[0].coverFile;
  fs.writeFileSync(path.join(src, 'notes.png'), 'just text');
  fs.writeFileSync(path.join(src, 'IMG_0001.HEIC'), 'ftypheic');
  fs.writeFileSync(path.join(src, 'page.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  fs.mkdirSync(path.join(src, 'folder.png'));
  fs.writeFileSync(path.join(src, 'huge.png'), PNG);
  fs.truncateSync(path.join(src, 'huge.png'), 25 * 1024 * 1024 + 1);
  for (const [file, want] of [
    ['notes.png', /not a picture this app can show/],
    ['IMG_0001.HEIC', /HEIC format: save it as a PNG or JPEG first/],
    ['page.svg', /not a picture this app can show/],
    ['folder.png', /not a picture file/],
    ['huge.png', /too big for a picture/],
    ['missing.png', /could not be read \(ENOENT\)/],
  ]) {
    const r = await lib.setCover(id, path.join(src, file));
    assert.strictEqual(r.ok, false, file);
    assert.match(r.message, want, file);
  }
  assert.match((await lib.setCover('local-nope', path.join(src, 'good.png'))).message, /no longer in the library/);
  assert.strictEqual(lib.games[0].coverFile, kept);
  assert.deepStrictEqual(fs.readdirSync(lib.dir).filter((f) => f.includes('.cover-')), [kept]);
});

test('a picture name in the list that leads elsewhere, or is no picture, is not used (the game stays)', async () => {
  const { lib } = await withOneGame();
  const game = JSON.parse(fs.readFileSync(path.join(lib.dir, 'local.json'), 'utf8'))[0];
  for (const coverFile of ['../../secret.png', '/etc/passwd', 'local.json', game.romFile, 'x.svg', 'a/b.png', '.hidden.png', 7, null, { name: 'x.png' }]) {
    fs.writeFileSync(path.join(lib.dir, 'local.json'), JSON.stringify([{ ...game, coverFile }]));
    const again = new LocalGames(lib.dir);
    await again.load();
    assert.strictEqual(again.games.length, 1, String(coverFile));
    assert.strictEqual(again.coverOf(again.games[0]), null, String(coverFile));
    assert.strictEqual(again.view()[0].cover, null, String(coverFile));
  }
});

test('a picture dropped where a game file is expected says what to do with it', async () => {
  const { src, lib } = await withOneGame();
  fs.writeFileSync(path.join(src, 'Box.png'), PNG);
  const r = await lib.add([path.join(src, 'Box.png')]);
  assert.deepStrictEqual(r.added, []);
  assert.match(r.skipped[0], /Box\.png: to give a game a picture, drop the picture onto a game you added/);
});
