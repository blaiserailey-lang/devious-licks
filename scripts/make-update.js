#!/usr/bin/env node
// Makes the files the app's Update button downloads (an "update pack", see
// src/packs.js) out of a packaged app:
//
//   dist/update/update.json   which version this is and which files make it up
//   dist/update/app.asar      the app's code
//   dist/update/dl-player, mupen64plus_next_libretro.dylib   the built-in player
//
// The release workflow attaches them to the GitHub release, next to the DMG.
//
//   node scripts/make-update.js                         from the app electron-builder left in dist/
//   node scripts/make-update.js --app <X.app> --out <folder>
//   node scripts/make-update.js --source --out <folder> from this source folder, code only
//                                                       (to try an update without building the Mac app)
//
// For the update test (scripts/test-update.js): the same code, but
//   --version 99.0.0    calling itself version 99.0.0
//   --fault throws      ...and failing as soon as it starts
//   --fault quits       ...and quitting without a word as soon as it starts
//   --fault hangs       ...and starting, but never opening a window
//   --fault dies        ...and opening its window, then dying half a second later
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');
const packs = require('../src/packs');

const ROOT = path.join(__dirname, '..');
// What the test's broken updates do. `replace` stands in for the app's
// main.js; `prepend` goes in front of the real one. (The ones that go away
// by themselves leave a line in the test's log first, so the test knows
// when, and which process.)
const NOTE = (what) => "try { require('fs').appendFileSync(process.env.DL_TEST_LOG, `[update-test] " + what + " ${process.pid}\\n`); } catch { /* no log */ }\n";
const FAULTS = {
  throws: { replace: "throw new Error('this test update is broken on purpose');\n" },
  quits: { replace: `// a test update that never comes up\n${NOTE('quitting')}require('electron').app.exit(0);\n` },
  hangs: { replace: 'setInterval(() => {}, 1000); // a test update that starts and then does nothing\n' },
  stumbles: { prepend: "setTimeout(() => { throw new Error('this test update trips over its own feet'); }, 300); // a test update that fails a moment after it starts\n" },
  dies: {
    prepend:
      '// a test update that opens its window and then dies\n' +
      "require('electron').app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => setTimeout(() => {\n" +
      `  ${NOTE('dying')}` +
      "  process.kill(process.pid, 'SIGKILL');\n" +
      '}, 500)));\n',
  },
};

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') opts.source = true;
    else if (['--app', '--out', '--version', '--fault'].includes(a) && i + 1 < argv.length) opts[a.slice(2)] = argv[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.version && !packs.parseVersion(opts.version)) throw new Error(`Not a version: ${opts.version}`);
  if (opts.fault && !FAULTS[opts.fault]) throw new Error(`--fault takes one of: ${Object.keys(FAULTS).join(', ')}`);
  return opts;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function findApp() {
  const dist = path.join(ROOT, 'dist');
  for (const sub of ['mac-universal', 'mac-arm64', 'mac']) {
    const dir = path.join(dist, sub);
    if (!fs.existsSync(dir)) continue;
    const app = fs.readdirSync(dir).find((n) => n.endsWith('.app'));
    if (app) return path.join(dir, app);
  }
  throw new Error('No packaged app in dist/. Build it first (npm run dist), or pass --app <X.app>.');
}

// The version of the engine (Electron) inside a packaged app.
function engineOf(app) {
  const plist = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'Info.plist');
  const m = /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(plist, 'utf8'));
  if (!m) throw new Error(`Could not read the engine's version from ${plist}`);
  return m[1];
}

// The start-up rules of every version that has gone out (test/fixtures).
function shipped() {
  const dir = path.join(ROOT, 'test', 'fixtures');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    /* (a copy of the scripts without the tests) */
  }
  return names
    .map((name) => /^packs-(\d+\.\d+\.\d+)\.js$/.exec(name))
    .filter(Boolean)
    .map((m) => ({ version: m[1], rules: require(path.join(dir, m[0])) }));
}

async function make(opts) {
  const out = path.resolve(opts.out || path.join(ROOT, 'dist', 'update'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-update-'));
  try {
    let engine;
    let archive; // the app.asar that goes into the pack
    let tree = null; // its contents as a folder, when they have to be changed
    const players = [];

    if (opts.source) {
      // The same three things electron-builder packs ("files" in package.json).
      engine = require('electron/package.json').version;
      tree = path.join(work, 'app');
      fs.cpSync(path.join(ROOT, 'src'), path.join(tree, 'src'), { recursive: true });
      fs.cpSync(path.join(ROOT, 'vendor'), path.join(tree, 'vendor'), { recursive: true, dereference: true });
      fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tree, 'package.json'));
    } else {
      const app = path.resolve(opts.app || findApp());
      const res = path.join(app, 'Contents', 'Resources');
      archive = path.join(res, 'app.asar');
      if (!fs.existsSync(archive)) throw new Error(`${app} has no Contents/Resources/app.asar`);
      // A pack carries one app.asar for both chips, and nothing beside it.
      for (const odd of ['app-arm64.asar', 'app-x64.asar', 'app.asar.unpacked']) {
        if (fs.existsSync(path.join(res, odd))) throw new Error(`${app} has ${odd}: this script only knows apps with a single app.asar`);
      }
      engine = engineOf(app);
      const playerDir = path.join(res, 'player');
      for (const name of fs.existsSync(playerDir) ? fs.readdirSync(playerDir).sort() : []) {
        const file = path.join(playerDir, name);
        const st = fs.lstatSync(file);
        if (!st.isFile()) throw new Error(`${file} is not a plain file: update packs carry plain files only`);
        players.push({ file, name, exec: (st.mode & 0o111) !== 0 });
      }
      if (!players.length) throw new Error(`${app} has no built-in player in Contents/Resources/player`);
      if (opts.version || opts.fault) {
        tree = path.join(work, 'app');
        asar.extractAll(archive, tree);
      }
    }

    if (tree) {
      const pkgFile = path.join(tree, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (opts.version) pkg.version = opts.version;
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
      if (opts.fault) {
        const main = path.join(tree, 'src', 'main.js');
        const fault = FAULTS[opts.fault];
        fs.writeFileSync(main, fault.replace || fault.prepend + fs.readFileSync(main, 'utf8'));
      }
      archive = path.join(work, 'app.asar');
      await asar.createPackage(tree, archive);
    }

    const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
    for (const needed of ['src/main.js', 'src/packs.js', 'src/renderer/index.html']) asar.statFile(archive, needed); // throws when missing
    const settings = (pkg.deviousLicks && pkg.deviousLicks.update) || {};

    // The output folder is cleared first, so it must be one of ours: new,
    // empty, or holding an earlier update. Anything else is left alone.
    if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, 'update.json'))) {
      throw new Error(`${out} has other things in it. Give --out a new or empty folder (it is cleared before the update files are written).`);
    }
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const files = [];
    const add = (from, name, to, exec) => {
      fs.copyFileSync(from, path.join(out, name));
      files.push({ name, to, size: fs.statSync(from).size, sha256: sha256(from), exec });
    };
    add(archive, 'app.asar', 'app.asar', false);
    for (const p of players) add(p.file, p.name, `player/${p.name}`, p.exec);

    // checkManifest is the same check the app runs on what it downloads.
    const manifest = packs.checkManifest({
      format: packs.FORMAT,
      version: pkg.version,
      electron: engine,
      needsApp: settings.needsApp || '0.0.0',
      notes: settings.notes || '',
      files,
    });
    // Would the start-up code that is already on people's Macs start this?
    // (It can't be replaced by an update; see test/frozen.test.js.) An
    // install that "needsApp" sends to the download page anyway is not asked.
    for (const { version, rules } of shipped()) {
      if (!packs.newer(manifest.version, version) || packs.newer(manifest.needsApp, version)) continue;
      const why = rules.accepts({ info: manifest, electron: manifest.electron, bundledVersion: version });
      if (why) {
        throw new Error(
          `An installed app of version ${version} would not start this update (${why}). Either change the update so that it does, ` +
            'or raise deviousLicks.update.needsApp in package.json to the first version whose installed app can take it ' +
            '(everyone below that is sent to the download page for a fresh DMG).'
        );
      }
    }
    fs.writeFileSync(path.join(out, 'update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { out, manifest };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { make, sha256 };

if (require.main === module) {
  make(parseArgs(process.argv.slice(2))).then(
    ({ out, manifest }) => {
      const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
      console.log(`Update pack ${manifest.version} (engine ${manifest.electron}, needs app ${manifest.needsApp} or later) in ${out}`);
      for (const f of manifest.files) console.log(`  ${f.name.padEnd(36)} ${mb(f.size).padStart(9)}  ${f.sha256.slice(0, 16)}…${f.exec ? '  (program)' : ''}`);
    },
    (err) => {
      console.error(`make-update: ${err.message}`);
      process.exit(1);
    }
  );
}
