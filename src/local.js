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
const PACKED = new Set(['.zip', '.7z', '.rar', '.gz']);

// A picture for a game added from a file: what kind of file it is is read
// from its first bytes, not from its name. It is copied next to the game and,
// like the game, never leaves this Mac.
const PICTURES = [
  ['png', (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a],
  ['jpg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['gif', (b) => b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))],
  ['webp', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
];
const PICTURE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const LOOKS_LIKE_A_PICTURE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg)$/i;
const MAX_PICTURE = 25 * 1024 * 1024;
// The picture's file name in local.json: a plain name in the games' folder, of a kind the window can show.
const COVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpg|gif|webp)$/;

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

  // The name of the game's picture file, if it has one this version can use.
  // (The field is optional: a version without pictures leaves it alone.)
  coverOf(game) {
    const name = game && game.coverFile;
    return typeof name === 'string' && COVER.test(name) && name !== game.romFile ? name : null;
  }

  // Gives a game the picture in the file `src`. Answers { ok, message }.
  async setCover(id, src) {
    const game = this.find(id);
    if (!game) return { ok: false, message: 'That game is no longer in the library' };
    const name = path.basename(String(src));
    let buf;
    try {
      const info = await fsp.stat(src);
      if (!info.isFile()) return { ok: false, message: `${name} is not a picture file` };
      if (info.size > MAX_PICTURE) return { ok: false, message: `${name} is too big for a picture (25 MB at most)` };
      buf = await fsp.readFile(src);
    } catch (err) {
      return { ok: false, message: `${name} could not be read (${(err && err.code) || 'error'})` };
    }
    const kind = PICTURES.find(([, starts]) => starts(buf));
    if (!kind) {
      return {
        ok: false,
        message: /\.hei[cf]$/i.test(name)
          ? `${name} is in the iPhone's HEIC format: save it as a PNG or JPEG first, then use that`
          : `${name} is not a picture this app can show (PNG, JPEG, GIF or WebP)`,
      };
    }
    // Named after the game's own file and the picture's fingerprint: a new picture is a new name.
    const stem = path.basename(game.romFile, path.extname(game.romFile)).slice(0, 80);
    const file = `${stem}.cover-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8)}.${kind[0]}`;
    if (!COVER.test(file) || file === game.romFile) return { ok: false, message: 'That picture could not be saved for this game' };
    const before = this.coverOf(game);
    try {
      await fsp.writeFile(path.join(this.dir, `${file}.tmp`), buf);
      await fsp.rename(path.join(this.dir, `${file}.tmp`), path.join(this.dir, file));
    } catch (err) {
      await fsp.rm(path.join(this.dir, `${file}.tmp`), { force: true }).catch(() => {});
      return { ok: false, message: `The picture could not be saved (${(err && err.code) || 'error'})` };
    }
    game.coverFile = file;
    await this.save();
    if (before && before !== file) await fsp.rm(path.join(this.dir, before), { force: true }).catch(() => {});
    return { ok: true, message: `${game.title} has its picture` };
  }

  // Returns { added: [titles], skipped: [reasons] }
  async add(files) {
    const result = { added: [], skipped: [] };
    for (const src of files) {
      const ext = path.extname(src).toLowerCase();
      const core = CORE_BY_EXT[ext];
      if (!core) {
        result.skipped.push(
          PACKED.has(ext)
            ? `${path.basename(src)}: unpack it first, then add the game file inside (.z64, .n64 or .v64 for N64)`
            : LOOKS_LIKE_A_PICTURE.test(ext)
              ? `${path.basename(src)}: to give a game a picture, drop the picture onto a game you added`
              : `${path.basename(src)}: not a supported game file`
        );
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
    const cover = this.coverOf(game);
    if (cover) await fsp.rm(path.join(this.dir, cover), { force: true }).catch(() => {});
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
      cover: this.coverOf(g) ? `app://local/${encodeURIComponent(this.coverOf(g))}` : null,
      local: true,
    }));
  }
}

module.exports = { LocalGames, EXTENSIONS, CORE_BY_EXT, PICTURE_EXTENSIONS };
