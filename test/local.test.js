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
