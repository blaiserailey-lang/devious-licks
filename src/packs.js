// Update packs: newer copies of the app's own code, kept in the app's data
// folder instead of inside the installed app.
//
// The app can't replace itself the way signed Mac apps do (that needs an
// Apple developer certificate), and macOS guards the installed app against
// changes. So an update never touches it. The Update button downloads the
// parts of the app that change from release to release (its code in
// app.asar, and the built-in players in player/) into
//   <the app's data folder>/updates/<version>/
// and boot.js, the first thing the installed app runs, starts the newest
// usable copy it finds there instead of the code it was installed with.
//
//   updates/current.json     { "version": "0.3.3" }   the pack to start
//   updates/state.json       { "good": "0.3.2", "starts": { "0.3.3": 1 }, "bad": { ... } }
//   updates/0.3.3/pack.json  what the pack is: format, version, electron, files
//   updates/0.3.3/app.asar, updates/0.3.3/player/...
//
// Everything here is plain logic with the file system handed in, so the same
// code runs in boot.js, in the updater and in the tests.
//
// boot.js and this file are the two parts of the app an update can't replace
// (a pack is started BY them), so they are kept small and careful: a pack is
// used only when every check passes, and anything unexpected means "run the
// installed code".
//
// What the installed copy of this file accepts is therefore what every later
// version has to live with on that Mac, until its owner installs a fresh DMG:
//   - versions are plain x.y.z;
//   - a pack is described by pack.json in format 1 (checkManifest below): up
//     to 500 plain files, each up to 2 GB, up to eight folders deep, with
//     plain ASCII names, one of them app.asar at the top;
//   - it must be newer than the installed app, made for the same major
//     version of the engine (Electron), and the installed app must be at
//     least its "needsApp";
//   - its code is started as <pack>/app.asar/src/main.js;
//   - state.json keeps good/starts/bad as described above; other keys in it
//     are left alone.
// A release that needs more than this has to raise "needsApp" (or the
// format), which sends older installs to the download page instead.
'use strict';
const path = require('path');

const FORMAT = 1;
const MAX_STARTS = 3; // a pack gets this many starts in a row without reporting in; at the next one it is set aside
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/; // a file's name on the release page
const PART = /^[A-Za-z0-9][A-Za-z0-9._ +@()=,~-]{0,99}$/; // one level of where it goes inside the pack
const MAX_FILE = 2 * 1024 * 1024 * 1024; // the most GitHub takes for one release file
const MAX_FILES = 500;
const MAX_DEPTH = 8;

function parseVersion(v) {
  const m = typeof v === 'string' ? VERSION.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// true when a is a later version than b (false when either isn't a version)
function newer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Is the engine (Electron) a pack was built for close enough to the one in
// this app? The same major version is: pack code that relies on something
// newer within it says so with "needsApp".
function sameEngine(a, b) {
  const major = (v) => (typeof v === 'string' && /^\d{1,4}\./.test(v) ? Number(v.split('.')[0]) : NaN);
  return major(a) === major(b);
}

// Where a pack's file goes inside the pack's folder: "app.asar",
// "player/dl-player". Only plain names, a few levels deep, never upward.
function safeTarget(to) {
  if (typeof to !== 'string') return null;
  const parts = to.split('/');
  if (!parts.length || parts.length > MAX_DEPTH) return null;
  for (const part of parts) if (!PART.test(part) || /[. ]$/.test(part)) return null;
  return parts.join('/');
}

// Checks an update description that came from the network (update.json) or
// from disk (pack.json) and returns a clean copy. Throws on anything odd.
function checkManifest(input) {
  const bad = (why) => new Error(`The update information is not valid (${why}).`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('not an object');
  if (!Number.isInteger(input.format) || input.format < 1) throw bad('format');
  if (!parseVersion(input.version)) throw bad('version');
  const out = { format: input.format, version: input.version };
  // A later format is for a later app: all this one needs to know is that it
  // can't take the update in place.
  if (input.format > FORMAT) return out;
  if (typeof input.electron !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(input.electron)) throw bad('electron');
  out.electron = input.electron;
  out.needsApp = input.needsApp === undefined ? '0.0.0' : input.needsApp;
  if (!parseVersion(out.needsApp)) throw bad('needsApp');
  out.notes = typeof input.notes === 'string' ? input.notes.replace(/[^\x20-\x7e\n]/g, ' ').slice(0, 600).trim() : '';
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > MAX_FILES) throw bad('files');
  const seen = new Set(['pack.json']); // the pack's own description lives there
  out.files = input.files.map((f) => {
    if (!f || typeof f !== 'object') throw bad('file entry');
    const to = safeTarget(f.to);
    if (!to || seen.has(to.toLowerCase())) throw bad('file target');
    seen.add(to.toLowerCase());
    if (typeof f.name !== 'string' || !NAME.test(f.name)) throw bad('file name');
    if (!Number.isInteger(f.size) || f.size < 1 || f.size > MAX_FILE) throw bad('file size');
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) throw bad('file hash');
    return { name: f.name, to, size: f.size, sha256: f.sha256, exec: f.exec === true };
  });
  if (!seen.has('app.asar')) throw bad('no app.asar');
  // No file may sit where another one needs a folder ("a" next to "a/b").
  for (const f of out.files) {
    const parts = f.to.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) throw bad('file target');
  }
  return out;
}

function readJson(fs, file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Whole file or nothing: written beside the target, then moved over it.
// (Each running copy of the app writes under a name of its own, so two of
// them can't trip over each other's half-written file.)
function writeJson(fs, file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* tidy() sweeps it up later */
    }
    return false;
  }
}

// (Keys this version doesn't know are kept, so a later version can add its own.)
function readState(fs, dir) {
  const s = readJson(fs, path.join(dir, 'state.json')) || {};
  const plain = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
  return { ...s, good: parseVersion(s.good) ? s.good : null, starts: plain(s.starts), bad: plain(s.bad) };
}

function writeState(fs, dir, state) {
  return writeJson(fs, path.join(dir, 'state.json'), state);
}

// How many starts in a row a pack has had without reporting in. Whatever
// else may have ended up in the file counts as none.
function startsOf(state, version) {
  const n = state.starts[version];
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function isBad(state, version) {
  return typeof version === 'string' && Object.prototype.hasOwnProperty.call(state.bad, version);
}

// Can this app run a pack with this (checked) description? Returns '' when
// it can, otherwise why not.
function fits(pack, { electron, bundledVersion }) {
  if (pack.format !== FORMAT) return 'it is in a later format than this app reads';
  if (!sameEngine(pack.electron, electron)) return `it was built for engine ${pack.electron}, this app has ${electron}`;
  if (bundledVersion && newer(pack.needsApp, bundledVersion)) return `it needs the installed app to be ${pack.needsApp} or later`;
  return '';
}

// The same question about an update that is still on the server: `info` is
// its update.json. '' means: once its files are here, complete, this app's
// start-up code will run it.
function accepts({ info, electron, bundledVersion }) {
  let pack;
  try {
    pack = checkManifest(info);
  } catch {
    return 'its description is damaged, or too new for this app to read';
  }
  if (!newer(pack.version, bundledVersion)) return 'the installed app is already at this version or later';
  return fits(pack, { electron, bundledVersion });
}

// Is the pack for `version` complete and made for this app? Returns its
// description, or a string saying why not.
function inspect({ fs, dir, version, electron, bundledVersion }) {
  if (!parseVersion(version)) return 'not a version';
  const folder = path.join(dir, version);
  let pack;
  try {
    pack = checkManifest(readJson(fs, path.join(folder, 'pack.json')));
  } catch {
    return 'its description is missing or damaged';
  }
  if (pack.version !== version) return 'its description does not match';
  const why = fits(pack, { electron, bundledVersion });
  if (why) return why;
  for (const f of pack.files) {
    let size = -1;
    try {
      const st = fs.statSync(path.join(folder, f.to));
      if (st.isFile()) size = st.size;
    } catch {
      /* missing */
    }
    if (size !== f.size) return `${f.to} is missing or incomplete`;
  }
  return { ...pack, dir: folder };
}

// Which pack should start? The current one, else the last one known to work;
// null means "the installed code". A pack must be newer than the installed
// app, complete, made for this app's engine and not set aside as bad. One
// that was started three times in a row without reporting in is set aside at
// the next start. Every pack that was passed over is added to `skipped`
// (when given) as { version, why }, so the code that does start can tell the
// person.
function choose({ fs, dir, bundledVersion, electron, skipped = [] }) {
  const current = readJson(fs, path.join(dir, 'current.json'));
  const state = readState(fs, dir);
  const candidates = [];
  if (current && parseVersion(current.version)) candidates.push(current.version);
  if (state.good && !candidates.includes(state.good)) candidates.push(state.good);
  for (const version of candidates) {
    const skip = (why) => skipped.push({ version, why: String(why).slice(0, 300) });
    if (!newer(version, bundledVersion)) {
      skip('the installed app is already at this version or later');
      continue;
    }
    if (isBad(state, version)) {
      skip(`it was set aside: ${state.bad[version]}`);
      continue;
    }
    if (startsOf(state, version) >= MAX_STARTS) {
      const why = `did not come up on ${MAX_STARTS} starts in a row`;
      markBad(fs, dir, version, why);
      skip(`it was set aside: ${why}`);
      continue;
    }
    const pack = inspect({ fs, dir, version, electron, bundledVersion });
    if (typeof pack === 'string') {
      skip(pack);
      continue;
    }
    return pack;
  }
  return null;
}

// Counted before a pack is started, cleared once its window is up.
function noteStart(fs, dir, version) {
  const state = readState(fs, dir);
  state.starts[version] = startsOf(state, version) + 1;
  return writeState(fs, dir, state);
}

// Takes one start back off the count: for a start that says nothing about
// the pack (a second copy of the app that hands over to the first and quits).
function unnoteStart(fs, dir, version) {
  const state = readState(fs, dir);
  const left = startsOf(state, version) - 1;
  if (left > 0) state.starts[version] = left;
  else delete state.starts[version];
  return writeState(fs, dir, state);
}

function noteGood(fs, dir, version) {
  const state = readState(fs, dir);
  state.starts = {};
  state.good = version;
  return writeState(fs, dir, state);
}

function markBad(fs, dir, version, why) {
  const state = readState(fs, dir);
  state.bad[version] = String(why || 'failed').slice(0, 300);
  delete state.starts[version];
  if (state.good === version) state.good = null;
  return writeState(fs, dir, state);
}

function clearBad(fs, dir, version) {
  const state = readState(fs, dir);
  delete state.bad[version];
  delete state.starts[version];
  return writeState(fs, dir, state);
}

// Drops the notes about versions the installed app has caught up with.
function forget(fs, dir, bundledVersion) {
  const state = readState(fs, dir);
  let changed = false;
  for (const group of [state.bad, state.starts]) {
    for (const version of Object.keys(group)) {
      if (newer(version, bundledVersion)) continue;
      delete group[version];
      changed = true;
    }
  }
  if (state.good && !newer(state.good, bundledVersion)) {
    state.good = null;
    changed = true;
  }
  return changed ? writeState(fs, dir, state) : true;
}

// Removes pack folders and half-finished downloads nobody needs any more.
// `keep` lists the versions to leave alone.
function tidy(fs, dir, keep = []) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const isPack = parseVersion(name) && !keep.includes(name);
    const isLeftover = /^staging-/.test(name) || /\.tmp$/.test(name);
    if (!isPack && !isLeftover) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      /* try again next time */
    }
  }
}

module.exports = {
  FORMAT, MAX_STARTS, parseVersion, newer, sameEngine, safeTarget, checkManifest, readJson, writeJson,
  readState, isBad, fits, accepts, inspect, choose, noteStart, unnoteStart, noteGood, markBad, clearBad, forget, tidy,
};
