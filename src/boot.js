// The first thing the installed app runs. It starts the app's code: the newest
// usable update pack when there is one (see packs.js), otherwise the code the
// app was installed with (main.js next to this file).
//
// An update can replace everything except this file and packs.js, because a
// pack is started by them. What they promise to the code they start is the
// object in global.devious, and that promise has to hold for every later
// version:
//   api              1
//   bundledVersion   the version of the installed app
//   updates          the folder the packs live in
//   pack             the pack that is running ({ version, dir, ... }), or null
//   skipped          packs that were passed over at this start: [{ version, why }]
//   started()        "my window is up": the pack is now known to work
//   failed(why)      "I can't run": set the pack aside and start again without it
// A pack has to call started() within two minutes of being started, or it is
// treated as failed.
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('original-fs'); // Electron's own fs treats app.asar as a folder; this one sees the file
const packs = require('./packs');
const bundledVersion = require('../package.json').version;

// Test runs keep their files out of the real library.
if (process.env.DL_USER_DATA) app.setPath('userData', path.resolve(process.env.DL_USER_DATA));
else if (process.argv.includes('--smoke-test')) app.setPath('userData', path.join(app.getPath('temp'), `devious-licks-smoke-${process.pid}`));

const updates = path.join(app.getPath('userData'), 'updates');
const SKIP = '--installed-code'; // start without any update pack (also a way out if one misbehaves)
// How long a pack gets to say "my window is up". The pack's own code notices
// trouble sooner (see main.js); this is the backstop for one that can't even
// do that. (DL_BOOT_PATIENCE, in seconds, is for the update test.)
const asked = Number(process.env.DL_BOOT_PATIENCE);
const PATIENCE = asked >= 2 && asked <= 600 ? asked : 120;

function contract(pack, skipped) {
  let over = false;
  let backstop = null;
  const self = {
    api: 1,
    bundledVersion,
    updates,
    pack,
    skipped,
    started() {
      if (!pack || over) return;
      over = true;
      clearTimeout(backstop);
      packs.noteGood(fs, updates, pack.version);
    },
    failed(why) {
      if (!pack || over) return;
      over = true;
      clearTimeout(backstop);
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
  if (pack) backstop = setTimeout(() => self.failed(`did not come up within ${PATIENCE} seconds`), PATIENCE * 1000);
  return self;
}

// Nothing in here may keep the app from opening: whatever goes wrong while
// looking for a pack means "run the installed code".
let pack = null;
const skipped = [];
if (!process.argv.includes(SKIP)) {
  try {
    pack = packs.choose({ fs, dir: updates, bundledVersion, electron: process.versions.electron, skipped });
    // Every start of a pack is counted before it runs (and the count is
    // cleared once its window is up), so that one which keeps dying is
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
