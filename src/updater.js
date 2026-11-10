// The Update button: finds out whether a newer version has been published,
// downloads it as an update pack (see packs.js) and gets it ready for the
// next start. Nothing here touches the installed app.
//
// Each release carries update.json (what the newest version is and which
// files make it up) and those files. They are fetched over HTTPS from the
// project's GitHub releases, checked against the sizes and SHA-256 hashes in
// update.json, and only then put in place.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline, finished } = require('stream/promises');
const packs = require('./packs');

const CHUNK = 1 << 20;
const STALLED = 'The connection to GitHub went quiet, so the app stopped waiting. Try again.';
const UNREADABLE = 'The update information could not be read. Try again later.';
const REDIRECTED = 'The download was redirected somewhere unexpected.';
const NOT_SAVED = 'Could not save the update (is the disk full?).';

// Copies a file byte by byte into a new one and returns the SHA-256 of what
// was copied. (Not fs.copyFile: on a Mac that also carries over the marks
// macOS keeps on a file, such as "this came from the internet", and a copy of
// the player with that mark on it would be refused when it is started.)
async function copyHashed(fs, from, to) {
  const hash = crypto.createHash('sha256');
  const tap = new Transform({
    transform(chunk, _encoding, pass) {
      hash.update(chunk);
      pass(null, chunk);
    },
  });
  await pipeline(fs.createReadStream(from, { highWaterMark: CHUNK }), tap, fs.createWriteStream(to, { flush: true }));
  return hash.digest('hex');
}

function fileSize(fs, file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

class Updater {
  // fs        a file system that sees app.asar as a file (original-fs in the app)
  // fetch     fetch(url, { signal }) answering like the standard fetch
  // dir       the updates folder
  // feed      where update.json is
  // fileUrl   (version, name) => where that file of that version is
  // allowed   (url) => may the download come from here? (asked about where a
  //           request ended up, when the fetch says; in the app the transport
  //           asks it about every redirect on the way)
  // running   what is running: { version, bundledVersion, electron,
  //             places:  folders laid out like a pack, to copy unchanged files from,
  //             skipped: packs the start-up code passed over at this start [{ version, why }],
  //             accepts: (update.json) => '' or why the installed start-up code won't run it,
  //             fresh:   this is the first start on this version }
  // onChange  called with view() whenever the state changes
  // patience  how long a server may stay silent, in ms: { answer, idle }
  constructor({ fs, fetch, dir, feed, fileUrl, allowed = () => true, running, onChange = () => {}, page = '', patience = {} }) {
    Object.assign(this, { fs, fetch, dir, feed, fileUrl, allowed, running, onChange, page });
    this.patience = { answer: 30000, idle: 60000, ...patience };
    this.state = { phase: 'idle' };
    this.manifest = null;
    this.busy = null; // a download in progress
    this.looking = null; // a check in progress
    this.fetched = new Set(); // versions downloaded during this run
    // A newer version that is on this Mac but was not started this time.
    this.passedOver = (running.skipped || []).find((s) => s && packs.newer(s.version, running.version)) || null;
  }

  // What the window shows:
  //   version, installed   what is running, and the installed app underneath it
  //   fresh                true on the first start after an update
  //   passedOver           { version, why }: a downloaded update that was not started this time
  //   phase                idle | checking | none | available | downloading | ready | download | error
  //   latest, notes, size  the version on offer
  //   failedBefore, why    'available': it was set aside on this Mac before, and why
  //   why                  'download': why it can't be taken with the button
  //   unknown              'none': nothing is published for the button to read
  //   percent              'downloading'
  //   error                'error'
  view() {
    const { version, bundledVersion, fresh } = this.running;
    const passedOver = this.passedOver ? { version: this.passedOver.version, why: String(this.passedOver.why || '') } : null;
    return { version, installed: bundledVersion, page: this.page, fresh: Boolean(fresh), passedOver, ...this.state };
  }

  set(state) {
    this.state = state;
    try {
      this.onChange(this.view());
    } catch {
      /* the window may be gone */
    }
    return this.view();
  }

  // One request. The server gets `patience.answer` to start answering and may
  // then never go quiet for longer than `patience.idle`: a connection that
  // just hangs must not leave the button stuck on "Checking…".
  async open(url) {
    const control = new AbortController();
    let timer = null;
    let gaveUp = false;
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        gaveUp = true;
        control.abort();
      }, ms);
    };
    arm(this.patience.answer);
    let res;
    try {
      res = await this.fetch(url, { cache: 'no-store', redirect: 'follow', signal: control.signal });
    } catch (err) {
      clearTimeout(timer);
      throw gaveUp ? new Error(STALLED) : err;
    }
    const req = {
      res,
      arm: () => arm(this.patience.idle), // call before each wait for more of the body
      stalled: () => gaveUp,
      end: () => {
        clearTimeout(timer);
        control.abort(); // lets go of whatever was not read
      },
    };
    if (res.url && !this.allowed(res.url)) {
      req.end();
      throw new Error(REDIRECTED);
    }
    return req;
  }

  async readText(req, limit) {
    const chunks = [];
    let got = 0;
    try {
      const reader = req.res.body ? req.res.body.getReader() : null;
      while (reader) {
        req.arm();
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > limit) throw new Error('The update information is too large.');
        chunks.push(Buffer.from(value));
      }
    } catch (err) {
      throw req.stalled() ? new Error(STALLED) : err;
    } finally {
      req.end();
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // Looks for a newer version. Never throws: problems end up in the state.
  // While a download runs, or another look is under way, it joins that.
  check() {
    if (this.busy) return Promise.resolve(this.view());
    if (!this.looking) {
      this.looking = this.look().finally(() => {
        this.looking = null;
      });
    }
    return this.looking;
  }

  async look() {
    this.set({ phase: 'checking' });
    try {
      const req = await this.open(this.feed);
      if (req.res.status === 404) {
        // Nothing published for in-app updates (yet): not an error, but not
        // "you have the newest version" either.
        req.end();
        return this.set({ phase: 'none', unknown: true });
      }
      if (!req.res.ok) {
        req.end();
        throw new Error(`The update server answered ${req.res.status} instead of the list of updates. Try again later.`);
      }
      const text = await this.readText(req, 100000);
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error(UNREADABLE);
      }
      let manifest;
      try {
        manifest = packs.checkManifest(raw);
      } catch (err) {
        // Not something this version can make sense of. If it does name a
        // newer version, the honest answer is "that one needs the full
        // download", not an error at every look from now on.
        if (raw && typeof raw === 'object' && packs.newer(raw.version, this.running.version)) {
          return this.set({ phase: 'download', latest: raw.version, why: 'this version of the app cannot read its description' });
        }
        throw err;
      }
      this.manifest = manifest;
      const latest = manifest.version;
      if (!packs.newer(latest, this.running.version)) return this.set({ phase: 'none' });
      const why = this.refusal(manifest);
      if (why) return this.set({ phase: 'download', latest, why });
      if (this.waiting() === latest) return this.set({ phase: 'ready', latest, notes: manifest.notes });
      const size = manifest.files.reduce((n, f) => n + f.size, 0);
      const state = packs.readState(this.fs, this.dir);
      if (packs.isBad(state, latest)) {
        return this.set({ phase: 'available', latest, notes: manifest.notes, size, failedBefore: true, why: String(state.bad[latest]) });
      }
      return this.set({ phase: 'available', latest, notes: manifest.notes, size, failedBefore: false });
    } catch (err) {
      return this.set({ phase: 'error', error: friendly(err) });
    }
  }

  // Why an update can't be taken in place ('' when it can): made for another
  // engine, for a newer installed app, or in a later format. It has to suit
  // this code's rules and those of the start-up code in the installed app,
  // which may be an older copy of them (see boot.js).
  refusal(manifest) {
    const own = packs.fits(manifest, this.running);
    if (own) return own;
    try {
      return (this.running.accepts && this.running.accepts(manifest)) || '';
    } catch {
      return '';
    }
  }

  // The version that is downloaded and will start next time, if any.
  waiting() {
    const current = packs.readJson(this.fs, path.join(this.dir, 'current.json'));
    const version = current && current.version;
    if (!packs.newer(version, this.running.version)) return null;
    if (packs.isBad(packs.readState(this.fs, this.dir), version)) return null;
    // The start-up code saw it when this run began and passed it over: as it
    // is, another restart would not change that.
    if (!this.fetched.has(version) && (this.running.skipped || []).some((s) => s && s.version === version)) return null;
    const pack = packs.inspect({ fs: this.fs, dir: this.dir, version, electron: this.running.electron, bundledVersion: this.running.bundledVersion });
    return typeof pack === 'string' ? null : version;
  }

  // Downloads the version check() found and makes it the one to start next.
  async install() {
    if (this.looking) await this.looking;
    if (!this.busy) {
      this.busy = this.download().finally(() => {
        this.busy = null;
      });
    }
    return this.busy;
  }

  async download() {
    const manifest = this.manifest;
    if (!manifest || this.state.phase !== 'available') return this.view();
    const { fs, dir } = this;
    const latest = manifest.version;
    const staging = path.join(dir, `staging-${latest}`);
    const folder = path.join(dir, latest);
    const total = manifest.files.reduce((n, f) => n + f.size, 0);
    let done = 0;
    let shown = -1;
    let moved = false;
    const progress = (bytes) => {
      done += bytes;
      const percent = Math.min(99, Math.floor((done / total) * 100));
      if (percent !== shown) this.set({ phase: 'downloading', latest, percent: (shown = percent) });
    };
    try {
      progress(0);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      for (const file of manifest.files) {
        const target = path.join(staging, file.to);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (!(await this.reuse(file, target))) await this.fetchFile(latest, file, target, progress);
        else progress(file.size);
        fs.chmodSync(target, file.exec ? 0o755 : 0o644);
      }
      if (!packs.writeJson(fs, path.join(staging, 'pack.json'), manifest)) throw new Error(NOT_SAVED);
      fs.rmSync(folder, { recursive: true, force: true });
      fs.renameSync(staging, folder);
      moved = true;
      const pack = packs.inspect({ fs, dir, version: latest, electron: this.running.electron, bundledVersion: this.running.bundledVersion });
      if (typeof pack === 'string') throw new Error(`The update did not arrive whole: ${pack}.`);
      packs.clearBad(fs, dir, latest);
      if (!packs.writeJson(fs, path.join(dir, 'current.json'), { version: latest })) throw new Error(NOT_SAVED);
      this.fetched.add(latest);
      return this.set({ phase: 'ready', latest, notes: manifest.notes });
    } catch (err) {
      // Nothing half-done stays behind: an error means nothing has changed.
      for (const leftover of moved ? [staging, folder] : [staging]) {
        try {
          fs.rmSync(leftover, { recursive: true, force: true });
        } catch {
          /* tidied up at the next start */
        }
      }
      return this.set({ phase: 'error', error: friendly(err), latest });
    }
  }

  // A file that hasn't changed since the version that is running is copied
  // from there instead of downloaded again.
  async reuse(file, target) {
    for (const place of this.running.places || []) {
      const have = path.join(place, file.to);
      if (fileSize(this.fs, have) !== file.size) continue;
      try {
        if ((await copyHashed(this.fs, have, target)) === file.sha256) return true;
      } catch {
        /* fall back to downloading it */
      }
      try {
        this.fs.rmSync(target, { force: true });
      } catch {
        /* the download writes over it */
      }
    }
    return false;
  }

  async fetchFile(version, file, target, progress) {
    const req = await this.open(this.fileUrl(version, file.name));
    if (!req.res.ok || !req.res.body) {
      req.end();
      throw new Error(`Could not download ${file.name} (the server answered ${req.res.status}). Try again later.`);
    }
    const hash = crypto.createHash('sha256');
    const out = this.fs.createWriteStream(target, { flush: true }); // on the disk before it counts
    const failed = new Promise((_, reject) => out.once('error', reject));
    failed.catch(() => {}); // (reported through the races below)
    let got = 0;
    try {
      const reader = req.res.body.getReader();
      for (;;) {
        req.arm();
        const { done, value } = await Promise.race([reader.read(), failed]);
        if (done) break;
        got += value.length;
        if (got > file.size) throw new Error(`${file.name} is larger than it should be.`);
        hash.update(value);
        if (!out.write(value)) await Promise.race([new Promise((r) => out.once('drain', r)), failed]);
        progress(value.length);
      }
      out.end();
      await finished(out); // written, flushed to the disk and closed
    } catch (err) {
      out.destroy();
      throw req.stalled() ? new Error(STALLED) : err;
    } finally {
      req.end();
    }
    if (got !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`${file.name} did not arrive intact. Try again.`);
  }

  // Housekeeping after a start: drop packs and leftovers nobody needs any
  // more. Kept: the pack that is running, the one waiting to start, and the
  // last one known to work. A pack that was set aside as bad is dropped (the
  // note about it stays, so the button can say it failed here before).
  tidy() {
    if (this.busy) return; // not under a download's feet
    const { fs, dir } = this;
    const { version, bundledVersion } = this.running;
    const state = packs.readState(fs, dir);
    const wanted = (v) => packs.newer(v, bundledVersion) && !packs.isBad(state, v);
    const keep = [];
    if (packs.newer(version, bundledVersion)) keep.push(version); // never the code this is running from
    if (wanted(state.good)) keep.push(state.good);
    const current = packs.readJson(fs, path.join(dir, 'current.json'));
    if (current && wanted(current.version)) keep.push(current.version);
    else if (current) {
      // It points at a pack that failed, or at one the installed app has
      // caught up with: point it back at the last good one, or drop it.
      try {
        if (wanted(state.good)) packs.writeJson(fs, path.join(dir, 'current.json'), { version: state.good });
        else fs.rmSync(path.join(dir, 'current.json'), { force: true });
      } catch {
        /* harmless: the start-up code skips such a pack anyway */
      }
    }
    packs.forget(fs, dir, bundledVersion);
    packs.tidy(fs, dir, keep);
  }
}

// What the person is told when something went wrong. Trouble with the Mac's
// own disk is looked for first (its messages can contain words like "network"
// in a folder's name), and a file's path is never shown.
function friendly(err) {
  const msg = String((err && err.message) || err);
  const code = (err && typeof err.code === 'string' && err.code) || (/^(E[A-Z]{2,12}):/.exec(msg) || [])[1] || '';
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'There is not enough free space on this Mac for the update.';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return "The app can't write to its own data folder on this Mac, so it can't keep the update.";
  if (/^(ENOENT|ENOTDIR|EISDIR|EEXIST|ENOTEMPTY|EBUSY|EIO|EMFILE|ENFILE|ENAMETOOLONG|EXDEV)$/.test(code)) {
    return `The app could not save the update on this Mac (${code}). Try again.`;
  }
  if (/ERR_CERT_|ERR_SSL_|certificate/i.test(msg)) return "This network is getting in the way of the secure connection to GitHub, so nothing was downloaded. Try again on another network.";
  if (/net::ERR_|fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|Premature close/i.test(msg)) {
    return "Can't reach GitHub right now. Check your internet connection and try again.";
  }
  return msg;
}

module.exports = { Updater, friendly, STALLED };
