// The start-up code inside an installed app (src/boot.js, src/packs.js) can't
// be replaced by an update: it is what starts one. So every version of it
// that has gone out is kept here, as test/fixtures/packs-<version>.js, and
// whatever the app does today has to keep working with each of them:
//   - an update put in place by today's Update button must be started by them;
//   - what today's code writes into the updates folder must mean the same to them.
// (scripts/make-update.js asks them too, about the real update files, every
// time a release is built.)
//
// When a version with changed start-up code ships, add its copy:
//   cp src/packs.js test/fixtures/packs-<version>.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const packs = require('../src/packs');
const { Updater } = require('../src/updater');
const { tmp, describe, serve } = require('./helpers');
const pkg = require('../package.json');

const FIXTURES = path.join(__dirname, 'fixtures');
const shipped = fs
  .readdirSync(FIXTURES)
  .map((name) => /^packs-(\d+\.\d+\.\d+)\.js$/.exec(name))
  .filter(Boolean)
  .map((m) => ({ version: m[1], file: path.join(FIXTURES, m[0]), rules: require(path.join(FIXTURES, m[0])) }));

test('the start-up rules of the first version with an Update button are on file', () => {
  assert.ok(shipped.some((s) => s.version === '0.3.2'));
});

test('the copy kept for the version being built is the one that ships', () => {
  const mine = shipped.find((s) => s.version === pkg.version);
  if (!mine) return; // start-up code unchanged since the last copy: nothing new to keep
  assert.strictEqual(
    fs.readFileSync(mine.file, 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'packs.js'), 'utf8'),
    `test/fixtures/packs-${pkg.version}.js has to be an exact copy of src/packs.js until ${pkg.version} is released`
  );
});

for (const { version: installed, rules } of shipped) {
  test(`an update put in by today's code is started by the start-up rules of ${installed}`, async () => {
    const next = '99.0.0';
    const files = { 'app.asar': `the app, version ${next} `.repeat(3000), 'player/dl-player': 'player', 'player/mupen64plus_next_libretro.dylib': 'core', 'player/LICENSE.txt': 'text' };
    const electron = '45.2.3';
    const manifest = describe(next, files, { electron, needsApp: installed });
    const routes = { '/update.json': JSON.stringify(manifest) };
    for (const [to, body] of Object.entries(files)) routes[`/v${next}/${path.basename(to)}`] = body;
    const site = await serve(routes);
    try {
      const dir = tmp('dl-frozen-');
      const about = { electron, bundledVersion: installed };
      const u = new Updater({
        fs, fetch, dir,
        feed: `${site.base}/update.json`,
        fileUrl: (v, name) => `${site.base}/v${v}/${name}`,
        running: { version: installed, ...about, places: [], skipped: [], accepts: (info) => rules.accepts({ info, ...about }) },
      });
      assert.strictEqual(rules.accepts({ info: manifest, ...about }), '', 'they would take it');
      assert.strictEqual((await u.check()).phase, 'available');
      assert.strictEqual((await u.install()).phase, 'ready');

      // The next start, as the installed app does it (see src/boot.js).
      const skipped = [];
      const pack = rules.choose({ fs, dir, ...about, skipped });
      assert.deepStrictEqual([pack && pack.version, pack && pack.dir, skipped], [next, path.join(dir, next), []]);
      assert.ok(fs.statSync(path.join(pack.dir, 'app.asar')).isFile());
      assert.ok(rules.noteStart(fs, dir, next));
      assert.deepStrictEqual(packs.readState(fs, dir).starts, { [next]: 1 }, "today's code reads their count");
      assert.ok(rules.noteGood(fs, dir, next));
      assert.strictEqual(packs.readState(fs, dir).good, next);

      // What today's code writes there means the same to them.
      assert.ok(packs.noteStart(fs, dir, next));
      assert.ok(packs.unnoteStart(fs, dir, next));
      assert.strictEqual(rules.choose({ fs, dir, ...about }).version, next);
      assert.ok(packs.markBad(fs, dir, next, 'switched off by hand'));
      assert.strictEqual(rules.choose({ fs, dir, ...about, skipped }), null, 'a version set aside today stays set aside for them');
      assert.match(skipped[0].why, /switched off by hand/);
      u.tidy();
      assert.strictEqual(fs.existsSync(path.join(dir, next)), false);
      assert.strictEqual(rules.choose({ fs, dir, ...about }), null);
    } finally {
      await site.close();
    }
  });
}
