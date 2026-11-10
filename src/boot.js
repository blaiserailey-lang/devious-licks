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
//   started()        "my window is up": the pack is now known to work
//   failed(why)      "I can't run": set the pack aside and start again without it
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

function contract(pack) {
  let over = false;
  return {
    api: 1,
    bundledVersion,
    updates,
    pack,
    started() {
      if (pack && !over) packs.noteGood(fs, updates, pack.version);
      over = true;
    },
    failed(why) {
      if (!pack || over) return;
      over = true;
      console.error(`[boot] update ${pack.version} set aside: ${why}`);
      const saved = packs.markBad(fs, updates, pack.version, why);
      // Start again in a fresh process. If the note could not be saved, tell
      // the next start in so many words not to pick this pack again.
      const args = process.argv.slice(1).filter((a) => a !== SKIP);
      app.relaunch({ args: saved ? args : [...args, SKIP] });
      app.exit(0);
    },
  };
}

let pack = null;
if (!process.argv.includes(SKIP)) {
  try {
    pack = packs.choose({ fs, dir: updates, bundledVersion, electron: process.versions.electron });
  } catch (err) {
    console.error(`[boot] could not look for updates: ${(err && err.message) || err}`);
  }
}

// Every start of a pack is counted before it runs (and the count is cleared
// once its window is up), so that one which keeps dying is caught. If the
// count can't be written down, that safety net is gone: don't use the pack.
if (pack && !packs.noteStart(fs, updates, pack.version)) {
  console.error(`[boot] could not write to ${updates}: running the installed code`);
  pack = null;
}

if (pack) {
  global.devious = contract(pack);
  console.log(`[boot] Devious Licks ${pack.version} (update pack; installed app ${bundledVersion})`);
  try {
    require(path.join(pack.dir, 'app.asar', 'src', 'main.js'));
  } catch (err) {
    global.devious.failed(`could not start: ${String((err && err.stack) || err).slice(0, 240)}`);
  }
} else {
  global.devious = contract(null);
  console.log(`[boot] Devious Licks ${bundledVersion} (installed code)`);
  require('./main.js');
}
