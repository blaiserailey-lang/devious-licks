// The first thing the installed app runs. It starts the app's code: the newest
// usable update pack when there is one (see packs.js), otherwise the code the
// app was installed with (main.js next to this file).
//
// An update can replace everything except this file and packs.js, because a
// pack is started by them. What they do is therefore what every later version
// has to live with on a Mac, until a fresh DMG is installed there:
//
//   - A pack's code is started with require('<pack>/app.asar/src/main.js').
//   - Every start of a pack is counted before it runs. The pack has two
//     minutes (of the Mac being awake) to answer through the object below;
//     one that doesn't is set aside and the app starts again without it. One
//     that was started three times in a row without answering (it quit, or
//     was closed, before it could) is set aside at the next start.
//   - Started with --installed-code, the app ignores every pack.
//   - Run from the source folder, it only looks for packs when DL_USER_DATA
//     names a data folder for the run (so a developer's copy never runs, or
//     tidies away, what the installed app has downloaded).
//
// What the started code finds in global.devious:
//   api              1
//   bundledVersion   the version of the installed app
//   updates          the folder the packs live in
//   pack             the pack that is running ({ version, dir, ... }), or null
//   skipped          packs passed over at this start: [{ version, why }]
//   rules            the installed copy of packs.js, which this start went by
//   accepts(info)    would this start-up code run the update described by
//                    `info` (its update.json) once its files are here?
//                    '' when it would, otherwise the reason why not
//   started()        "I'm up and working": the pack is now known to be good
//   failed(why)      "I can't run": set the pack aside, start again without it
//   excused()        "don't count this start": for one that proves nothing
//                    about the pack (a second copy of the app that hands over
//                    to the one already open, a quit before it could tell)
// Of started, failed and excused only the first call counts, and none of
// them does anything while the installed code is running. None of this
// throws.
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('original-fs'); // Electron's own fs treats app.asar as a folder; this one sees the file
const packs = require('./packs');
const bundledVersion = require('../package.json').version;

const electron = process.versions.electron;

// Test runs keep their files out of the real library.
if (process.env.DL_USER_DATA) app.setPath('userData', path.resolve(process.env.DL_USER_DATA));
else if (process.argv.includes('--smoke-test')) app.setPath('userData', path.join(app.getPath('temp'), `devious-licks-smoke-${process.pid}`));

const updates = path.join(app.getPath('userData'), 'updates');
const SKIP = '--installed-code'; // start without any update pack (also a way out if one misbehaves)
// How long a pack gets to answer. The pack's own code notices trouble sooner
// (see main.js); this is the backstop for one that can't even do that.
// (DL_BOOT_PATIENCE, in seconds, is for the update test.)
const asked = Number(process.env.DL_BOOT_PATIENCE);
const PATIENCE = asked >= 2 && asked <= 600 ? asked : 120;
const TICK = Math.min(5, PATIENCE);

function contract(pack, skipped) {
  let open = Boolean(pack); // still waiting for the pack's answer
  let backstop = null;
  const answer = () => {
    if (!open) return false;
    open = false;
    clearInterval(backstop);
    return true;
  };
  const self = {
    api: 1,
    bundledVersion,
    updates,
    pack,
    skipped,
    rules: packs,
    accepts(info) {
      try {
        return packs.accepts({ info, electron, bundledVersion });
      } catch {
        return 'it could not be checked';
      }
    },
    started() {
      if (!answer()) return;
      try {
        packs.noteGood(fs, updates, pack.version);
      } catch {
        /* the count stays; the next start that answers clears it */
      }
    },
    excused() {
      if (!answer()) return;
      try {
        packs.unnoteStart(fs, updates, pack.version);
      } catch {
        /* then this start counts after all */
      }
    },
    failed(why) {
      if (!answer()) return;
      // Start again in a fresh process. If the note about this pack could not
      // be saved, tell the next start in so many words not to pick it again.
      let saved = false;
      try {
        console.error(`[boot] update ${pack.version} set aside: ${why}`);
        saved = packs.markBad(fs, updates, pack.version, why);
      } catch {
        /* the relaunch below still gets the app out of this pack */
      }
      try {
        const args = process.argv.slice(1).filter((a) => a !== SKIP);
        app.relaunch({ args: saved ? args : [...args, SKIP] });
      } finally {
        app.exit(0);
      }
    },
  };
  if (pack) {
    // Counted in short steps instead of one long timer: a timer keeps
    // running while the Mac sleeps, and a pack must not be failed for the
    // lid having been closed on it.
    let waited = 0;
    backstop = setInterval(() => {
      waited += TICK;
      if (waited >= PATIENCE) self.failed(`did not come up within ${PATIENCE} seconds`);
    }, TICK * 1000);
  }
  return self;
}

// Nothing in here may keep the app from opening: whatever goes wrong while
// looking for a pack means "run the installed code".
let pack = null;
const skipped = [];
if (!process.argv.includes(SKIP) && (app.isPackaged || process.env.DL_USER_DATA)) {
  try {
    pack = packs.choose({ fs, dir: updates, bundledVersion, electron, skipped });
    // Every start of a pack is counted before it runs (and the count is
    // cleared once the pack answers), so that one which keeps dying is
    // caught. If the count can't be written down, that safety net is gone:
    // don't use the pack.
    if (pack && !packs.noteStart(fs, updates, pack.version)) {
      skipped.push({ version: pack.version, why: 'the app could not write to its updates folder' });
      pack = null;
    }
  } catch (err) {
    console.error(`[boot] could not look for updates: ${(err && err.message) || err}`);
    pack = null;
  }
  for (const s of skipped) console.error(`[boot] update ${s.version} not started: ${s.why}`);
}

if (pack) {
  global.devious = contract(pack, skipped);
  console.log(`[boot] Devious Licks ${pack.version} (update pack; installed app ${bundledVersion})`);
  try {
    require(path.join(pack.dir, 'app.asar', 'src', 'main.js'));
  } catch (err) {
    global.devious.failed(`could not start: ${String((err && err.stack) || err).slice(0, 240)}`);
  }
} else {
  global.devious = contract(null, skipped);
  console.log(`[boot] Devious Licks ${bundledVersion} (installed code)`);
  require('./main.js');
}
