// Fills in sha256 and size for every game in catalog/games.json, and checks
// that each ROM and cover exists. Run `npm run catalog` after changing a ROM;
// the "Catalog" GitHub Action also runs it on every push.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'catalog'));
const manifestPath = path.join(dir, 'games.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const CORES = ['nes', 'snes', 'gba', 'gb', 'gbc', 'segaMD', 'fceumm', 'snes9x', 'mgba', 'gambatte', 'genesis_plus_gx'];
const errors = [];
const ids = new Set();

for (const game of manifest.games || []) {
  const where = `game "${game.id || game.title || '?'}"`;
  for (const key of ['id', 'title', 'core', 'rom']) {
    if (!game[key]) errors.push(`${where}: missing "${key}"`);
  }
  if (game.id && !/^[a-z0-9][a-z0-9-]*$/.test(game.id)) errors.push(`${where}: id must be lowercase letters, numbers and dashes`);
  if (ids.has(game.id)) errors.push(`${where}: duplicate id`);
  ids.add(game.id);
  if (game.core && !CORES.includes(game.core)) errors.push(`${where}: core "${game.core}" is not bundled (use one of ${CORES.slice(0, 6).join(', ')})`);
  if (game.rom) {
    const romPath = path.join(dir, game.rom);
    if (!fs.existsSync(romPath)) {
      errors.push(`${where}: ROM not found at catalog/${game.rom}`);
    } else {
      const buf = fs.readFileSync(romPath);
      game.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      game.size = buf.length;
    }
  }
  if (game.cover) {
    const coverPath = path.join(dir, game.cover);
    if (!fs.existsSync(coverPath)) errors.push(`${where}: cover not found at catalog/${game.cover}`);
    else game.coverSha256 = crypto.createHash('sha256').update(fs.readFileSync(coverPath)).digest('hex');
  }
}

const next = JSON.stringify(manifest, null, 2) + '\n';
if (next !== fs.readFileSync(manifestPath, 'utf8')) {
  fs.writeFileSync(manifestPath, next);
  console.log('Updated hashes in games.json');
} else {
  console.log('games.json already up to date');
}
if (errors.length) {
  console.error('\nCatalog problems:\n  ' + errors.join('\n  '));
  process.exit(1);
}
