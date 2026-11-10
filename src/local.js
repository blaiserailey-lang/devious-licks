// Games added from a file on this Mac. They are copied into the app's own
// folder, never uploaded anywhere, and show up only in this Mac's library.
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const CORE_BY_EXT = {
  '.nes': 'nes',
  '.sfc': 'snes', '.smc': 'snes',
  '.gb': 'gb', '.gbc': 'gbc', '.gba': 'gba',
  '.md': 'segaMD', '.gen': 'segaMD', '.smd': 'segaMD',
  '.z64': 'n64', '.n64': 'n64', '.v64': 'n64',
};
const EXTENSIONS = Object.keys(CORE_BY_EXT).map((e) => e.slice(1));

function titleFromFile(file) {
  return path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// One game in local.json, as far as this version relies on it. (Its file sits
// right in the folder: a plain name, nothing that leads elsewhere.)
function valid(g) {
  return (
    Boolean(g) && typeof g === 'object' && !Array.isArray(g) &&
    typeof g.id === 'string' && Boolean(g.id) && typeof g.title === 'string' && typeof g.core === 'string' && Boolean(g.core) && typeof g.sha256 === 'string' &&
    typeof g.romFile === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(g.romFile)
  );
}

class LocalGames {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'local.json');
    this.games = [];
    this.others = []; // entries a later version wrote that this one can't use
    this.wrapper = null;
    this.unreadable = false;
  }

  // The list is the only record of which games were added on this Mac, and
  // a later version of the app may keep it differently. So whatever this
  // version can't read is kept, never written over:
  //   - a list wrapped in an object ({ ..., "games": [...] }) is read, and
  //     written back with the wrapper as it was;
  //   - entries it doesn't understand are left out of the library and
  //     written back as they were;
  //   - a file it can't make sense of at all is moved aside before the first
  //     save (local.json.unreadable-<time>).
  async load() {
    await fsp.mkdir(this.dir, { recursive: true });
    this.games = [];
    this.others = [];
    this.wrapper = null;
    this.unreadable = false;
    let text;
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch {
      return; // nothing added yet
    }
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray(data.games) ? data.games : null;
      if (!list) throw new Error('not a list of games');
      if (!Array.isArray(data)) this.wrapper = data;
      this.games = list.filter(valid);
      this.others = list.filter((g) => !valid(g));
    } catch {
      this.unreadable = true;
    }
  }

  async save() {
    if (this.unreadable) {
      await fsp.rename(this.file, `${this.file}.unreadable-${Date.now()}`).catch(() => {});
      this.unreadable = false;
    }
    const list = [...this.games, ...(this.others || [])];
    await fsp.writeFile(`${this.file}.tmp`, JSON.stringify(this.wrapper ? { ...this.wrapper, games: list } : list, null, 2));
    await fsp.rename(`${this.file}.tmp`, this.file);
  }

  find(id) {
    return this.games.find((g) => g.id === id);
  }

  romPath(game) {
    return path.join(this.dir, game.romFile);
  }

  // Returns { added: [titles], skipped: [reasons] }
  async add(files) {
    const result = { added: [], skipped: [] };
    for (const src of files) {
      const ext = path.extname(src).toLowerCase();
      const core = CORE_BY_EXT[ext];
      if (!core) {
        result.skipped.push(`${path.basename(src)}: not a supported game file`);
        continue;
      }
      // One file that can't be read or copied must not cost the others their place in the list.
      try {
        const buf = await fsp.readFile(src);
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        const existing = this.games.find((g) => g.sha256 === sha256);
        if (existing) {
          result.skipped.push(`${existing.title} is already in your library`);
          continue;
        }
        const id = `local-${sha256.slice(0, 12)}`;
        const romFile = `${id}${ext}`;
        await fsp.writeFile(path.join(this.dir, romFile), buf);
        const title = titleFromFile(src);
        this.games.push({ id, title, core, romFile, sha256, addedAt: new Date().toISOString() });
        result.added.push(title);
      } catch (err) {
        result.skipped.push(`${path.basename(src)}: could not be read (${(err && err.code) || 'error'})`);
      }
    }
    await this.save();
    return result;
  }

  async remove(id) {
    const game = this.find(id);
    if (!game) return;
    await fsp.rm(this.romPath(game), { force: true });
    this.games = this.games.filter((g) => g.id !== id);
    await this.save();
  }

  view() {
    return this.games.map((g) => ({
      id: g.id,
      title: g.title,
      core: g.core,
      description: '',
      version: '',
      players: 1,
      status: null,
      cover: null,
      local: true,
    }));
  }
}

module.exports = { LocalGames, EXTENSIONS, CORE_BY_EXT };
