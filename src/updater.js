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
const packs = require('./packs');

const CHUNK = 1 << 20;

function hashFile(fs, file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: CHUNK })
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Copies a file byte by byte into a new one and returns the SHA-256 of what
// was copied. (Not fs.copyFile: on a Mac that also carries over the marks
// macOS keeps on a file, such as "this came from the internet", and a copy of
// the player with that mark on it would be refused when it is started.)
function copyHashed(fs, from, to) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(from, { highWaterMark: CHUNK });
    const output = fs.createWriteStream(to, { flush: true });
    input.on('data', (d) => hash.update(d));
    input.on('error', (err) => {
      output.destroy();
      reject(err);
    });
    output.on('error', (err) => {
      input.destroy();
      reject(err);
    });
    output.on('finish', () => resolve(hash.digest('hex')));
    input.pipe(output);
  });
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
  // fetch     fetch(url, options)
  // dir       the updates folder
  // feed      where update.json is
  // fileUrl   (version, name) => where that file of that version is
  // allowed   (url) => may the download come from here (after redirects)?
  // running   { version, bundledVersion, electron, places: [folders laid out like a pack] }
  // onChange  called with view() whenever the state changes
  constructor({ fs, fetch, dir, feed, fileUrl, allowed = () => true, running, onChange = () => {}, page = '' }) {
    Object.assign(this, { fs, fetch, dir, feed, fileUrl, allowed, running, onChange, page });
    this.state = { phase: 'idle' };
    this.manifest = null;
    this.busy = null; // a download in progress
    this.looking = null; // a check in progress
  }

  // What the window shows.
  view() {
    return { version: this.running.version, installed: this.running.bundledVersion, page: this.page, ...this.state };
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

  async get(url) {
    const res = await this.fetch(url, { cache: 'no-store', redirect: 'follow' });
    if (res.url && !this.allowed(res.url)) throw new Error('The download was redirected somewhere unexpected.');
    return res;
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
      const res = await this.get(this.feed);
      if (res.status === 404) return this.set({ phase: 'none' }); // nothing published for in-app updates yet
      if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
      const text = await res.text();
      if (text.length > 100000) throw new Error('The update information is too large.');
      const manifest = packs.checkManifest(JSON.parse(text));
      this.manifest = manifest;
      if (!packs.newer(manifest.version, this.running.version)) return this.set({ phase: 'none' });
      const latest = manifest.version;
      // Made for a different engine, or for a newer installed app than this
      // one: it can't be taken in place, it needs the full download.
      if (manifest.format > packs.FORMAT || manifest.electron !== this.running.electron || packs.newer(manifest.needsApp, this.running.bundledVersion)) {
        return this.set({ phase: 'download', latest });
      }
      const waiting = this.waiting();
      if (waiting === latest) return this.set({ phase: 'ready', latest, notes: manifest.notes });
      const size = manifest.files.reduce((n, f) => n + f.size, 0);
      const failedBefore = packs.isBad(packs.readState(this.fs, this.dir), latest);
      return this.set({ phase: 'available', latest, notes: manifest.notes, size, failedBefore });
    } catch (err) {
      return this.set({ phase: 'error', error: friendly(err) });
    }
  }

  // The version that is downloaded and will start next time, if any.
  waiting() {
    const current = packs.readJson(this.fs, path.join(this.dir, 'current.json'));
    const version = current && current.version;
    if (!packs.newer(version, this.running.version)) return null;
    if (packs.isBad(packs.readState(this.fs, this.dir), version)) return null;
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
    const total = manifest.files.reduce((n, f) => n + f.size, 0);
    let done = 0;
    let shown = -1;
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
      if (!packs.writeJson(fs, path.join(staging, 'pack.json'), manifest)) throw new Error('Could not save the update (is the disk full?).');
      const folder = path.join(dir, latest);
      fs.rmSync(folder, { recursive: true, force: true });
      fs.renameSync(staging, folder);
      const pack = packs.inspect({ fs, dir, version: latest, electron: this.running.electron, bundledVersion: this.running.bundledVersion });
      if (typeof pack === 'string') throw new Error(`The update did not arrive whole: ${pack}.`);
      packs.clearBad(fs, dir, latest);
      if (!packs.writeJson(fs, path.join(dir, 'current.json'), { version: latest })) throw new Error('Could not save the update (is the disk full?).');
      return this.set({ phase: 'ready', latest, notes: manifest.notes });
    } catch (err) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* tidied up at the next start */
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
    const res = await this.get(this.fileUrl(version, file.name));
    if (!res.ok || !res.body) throw new Error(`Could not download ${file.name} (GitHub answered ${res.status}).`);
    const hash = crypto.createHash('sha256');
    const out = this.fs.createWriteStream(target, { flush: true }); // on the disk before it counts
    const failed = new Promise((_, reject) => out.on('error', reject));
    let got = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), failed]);
        if (done) break;
        got += value.length;
        if (got > file.size) throw new Error(`${file.name} is larger than it should be.`);
        hash.update(value);
        if (!out.write(value)) await Promise.race([new Promise((r) => out.once('drain', r)), failed]);
        progress(value.length);
      }
      await Promise.race([new Promise((r) => out.end(r)), failed]);
    } catch (err) {
      out.destroy();
      throw err;
    }
    if (got !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`${file.name} did not arrive intact. Try again.`);
  }

  // Housekeeping after a start: drop packs and leftovers nobody needs any
  // more. Kept: the pack that is running, the one waiting to start, and the
  // last one known to work. A pack that was set aside as bad is dropped (the
  // note about it stays, so the button can say it failed here before).
  tidy() {
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

function friendly(err) {
  const msg = String((err && err.message) || err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ERR_NETWORK|network/i.test(msg)) return "Can't reach GitHub right now. Check your internet connection and try again.";
  if (/ENOSPC/.test(msg)) return 'There is not enough free space on this Mac for the update.';
  if (/JSON|Unexpected token/.test(msg)) return 'The update information could not be read. Try again later.';
  return msg;
}

module.exports = { Updater, hashFile };
