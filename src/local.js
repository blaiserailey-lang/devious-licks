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

class LocalGames {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'local.json');
    this.games = [];
  }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      this.games = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch {
      this.games = [];
    }
  }

  async save() {
    await fsp.writeFile(`${this.file}.tmp`, JSON.stringify(this.games, null, 2));
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
