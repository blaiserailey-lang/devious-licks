// Keeps a local copy of the Devious Licks catalog in sync with GitHub.
//
// The catalog lives in a GitHub repo as catalog/games.json plus ROM and cover
// files. A refresh resolves the branch to its latest commit (so GitHub's raw
// file cache never serves stale games), downloads games.json, then fetches only
// the ROMs and covers whose sha256 changed. Everything is cached on disk so the
// library opens and plays offline.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// "New" and "Updated" badges stay on a game for this long after it changes.
const BADGE_MS = 7 * 24 * 60 * 60 * 1000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function safeExt(file, fallback) {
  const ext = path.extname(file || '').toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : fallback;
}

// A game's id becomes the name of its files in the library folder, so it has
// to be a plain name (the same rule scripts/update-catalog.js checks).
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The name of a cached file, as this code makes them up: <id>.<ext>
const CACHED = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9]{1,8}$/;
// Where a file sits inside the catalog folder: "roms/game.nes". Never upward.
function catalogPath(file) {
  if (typeof file !== 'string' || !file || file.length > 300 || file.includes('\\')) return false;
  return file.split('/').every((part) => part && part !== '.' && part !== '..');
}

// One entry of games.json, as far as the app relies on it.
function validEntry(g) {
  return Boolean(g) && typeof g === 'object' && typeof g.id === 'string' && ID.test(g.id) && catalogPath(g.rom) && typeof g.core === 'string' && Boolean(g.core);
}

// One game as kept in library.json.
function validCached(g) {
  return (
    Boolean(g) && typeof g === 'object' && typeof g.id === 'string' && ID.test(g.id) &&
    typeof g.romFile === 'string' && CACHED.test(g.romFile) &&
    (g.coverFile === undefined || g.coverFile === null || (typeof g.coverFile === 'string' && CACHED.test(g.coverFile)))
  );
}

// A source knows how to fetch catalog files, either from GitHub or (for
// local testing) from a folder on disk.
function githubSource({ owner, repo, branch = 'main', path: dir = 'catalog', token }) {
  const headers = { 'User-Agent': 'DeviousLicks-Library' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let ref = branch;
  return {
    describe: () => `github.com/${owner}/${repo}`,
    async resolve() {
      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`, {
          headers: { ...headers, Accept: 'application/vnd.github.sha' },
        });
        if (res.ok) ref = (await res.text()).trim();
        else ref = branch;
      } catch {
        ref = branch;
      }
      return ref;
    },
    async get(file) {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${dir}/${file.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(url, { headers, cache: 'no-store' });
      if (!res.ok) throw new Error(`Could not download ${file} (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

function folderSource(dir) {
  const base = path.resolve(dir);
  return {
    describe: () => base,
    resolve: async () => 'local',
    async get(file) {
      const full = path.resolve(base, file);
      if (!full.startsWith(base + path.sep)) throw new Error(`Bad path ${file}`);
      return fsp.readFile(full);
    },
  };
}

class Library {
  constructor(dir, source) {
    this.dir = dir;
    this.source = source;
    this.stateFile = path.join(dir, 'library.json');
    this.state = { games: [], syncedAt: null, ref: null };
  }

  async load() {
    await fsp.mkdir(path.join(this.dir, 'roms'), { recursive: true });
    await fsp.mkdir(path.join(this.dir, 'covers'), { recursive: true });
    try {
      // Only what this version can make sense of: the file is a cache, and
      // the next refresh rebuilds whatever is left out here.
      const saved = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
      if (saved && typeof saved === 'object' && Array.isArray(saved.games)) {
        this.state = { ...saved, games: saved.games.filter(validCached), syncedAt: typeof saved.syncedAt === 'string' ? saved.syncedAt : null };
      }
    } catch {
      /* first run */
    }
    return this.view();
  }

  romPath(game) {
    return path.join(this.dir, 'roms', game.romFile);
  }

  coverPath(game) {
    return game.coverFile ? path.join(this.dir, 'covers', game.coverFile) : null;
  }

  find(id) {
    return this.state.games.find((g) => g.id === id);
  }

  view() {
    return {
      source: this.source.describe(),
      syncedAt: this.state.syncedAt,
      studio: this.state.studio || 'Devious Licks',
      games: this.state.games.map((g) => ({
        id: g.id,
        title: g.title,
        core: g.core,
        description: g.description || '',
        version: g.version || '',
        players: g.players || 1,
        year: g.year || '',
        status: g.changedAt && Date.now() - Date.parse(g.changedAt) < BADGE_MS ? g.status : null,
        cover: g.coverFile ? `app://cover/${encodeURIComponent(g.coverFile)}?v=${(g.coverSha256 || '').slice(0, 12)}` : null,
      })),
    };
  }

  async writeAtomic(target, buf) {
    const tmp = `${target}.download`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, target);
  }

  // onProgress({ phase, message, done, total })
  async refresh(onProgress = () => {}) {
    onProgress({ phase: 'start', message: 'Checking for new games…' });
    const ref = await this.source.resolve();
    const manifest = JSON.parse((await this.source.get('games.json')).toString('utf8'));
    const listed = manifest && Array.isArray(manifest.games) ? manifest.games : [];
    const ids = new Set();
    const incoming = listed.filter((g) => validEntry(g) && !ids.has(g.id) && ids.add(g.id));
    const previous = new Map(this.state.games.map((g) => [g.id, g]));
    const next = [];
    const firstSync = !this.state.syncedAt;
    const summary = { added: [], updated: [], removed: [], failed: [] };
    if (incoming.length < listed.length) summary.failed.push(`${listed.length - incoming.length} catalog ${listed.length - incoming.length === 1 ? 'entry is' : 'entries are'} not valid and ${listed.length - incoming.length === 1 ? 'was' : 'were'} left out`);

    let done = 0;
    for (const entry of incoming) {
      onProgress({ phase: 'game', message: `Syncing ${entry.title || entry.id}`, done, total: incoming.length });
      const old = previous.get(entry.id);
      const game = {
        ...entry,
        romFile: `${entry.id}${safeExt(entry.rom, '.bin')}`,
        coverFile: old && old.coverFile,
        coverSha256: old && old.coverSha256,
        status: null,
      };
      try {
        const romTarget = this.romPath(game);
        const cached = old && old.romFile === game.romFile && fs.existsSync(romTarget);
        let changed = !(cached && entry.sha256 && old.sha256 === entry.sha256);
        if (changed) {
          // Download when the hash differs (or games.json has no hash yet).
          const buf = await this.source.get(entry.rom);
          const got = sha256(buf);
          if (entry.sha256 && got !== entry.sha256) throw new Error('ROM download was corrupted (hash mismatch)');
          changed = !(cached && old.sha256 === got);
          if (changed) {
            if (old && old.romFile !== game.romFile) await fsp.rm(this.romPath(old), { force: true });
            await this.writeAtomic(romTarget, buf);
          }
          game.sha256 = got;
        }
        if (changed) {
          // Everything is "new" on the very first sync, so skip badges then.
          game.status = old ? 'updated' : firstSync ? null : 'new';
          game.changedAt = new Date().toISOString();
          (old ? summary.updated : summary.added).push(game.title || game.id);
        } else {
          game.sha256 = old.sha256;
          game.status = old.status;
          game.changedAt = old.changedAt;
        }

        if (catalogPath(entry.cover)) {
          const coverFile = `${entry.id}${safeExt(entry.cover, '.png')}`;
          const coverTarget = path.join(this.dir, 'covers', coverFile);
          const haveCover = old && old.coverFile === coverFile && entry.coverSha256 && old.coverSha256 === entry.coverSha256 && fs.existsSync(coverTarget);
          if (!haveCover) {
            try {
              const buf = await this.source.get(entry.cover);
              await this.writeAtomic(coverTarget, buf);
              game.coverFile = coverFile;
              game.coverSha256 = entry.coverSha256 || sha256(buf);
            } catch {
              /* a missing cover shouldn't block the game */
            }
          }
        } else {
          game.coverFile = null;
        }
        next.push(game);
      } catch (err) {
        summary.failed.push(`${entry.title || entry.id}: ${err.message}`);
        if (old) next.push(old); // keep the last good version playable
      }
      done += 1;
    }

    const keep = new Set(next.map((g) => g.id));
    for (const old of this.state.games) {
      if (keep.has(old.id)) continue;
      summary.removed.push(old.title || old.id);
      await fsp.rm(this.romPath(old), { force: true });
      if (old.coverFile) await fsp.rm(path.join(this.dir, 'covers', old.coverFile), { force: true });
    }

    this.state = { studio: typeof manifest.studio === 'string' ? manifest.studio : undefined, games: next, ref, syncedAt: new Date().toISOString() };
    await this.writeAtomic(this.stateFile, Buffer.from(JSON.stringify(this.state, null, 2)));
    onProgress({ phase: 'done', message: 'Up to date', done, total: incoming.length });
    return { ...this.view(), summary };
  }
}

module.exports = { Library, githubSource, folderSource };
