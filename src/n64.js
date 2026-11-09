// What the launcher knows about N64 game files.
//
// The N64 emulator recognises commercial games by a fingerprint of the whole
// file and looks up the settings each one needs (CPU timing, save type...).
// A reskinned game has a different fingerprint, so the emulator treats it as
// an unknown game and runs it with generic settings, which some games can't
// take. The game code in the file's header survives a reskin, so the settings
// that matter are kept here, keyed on the two-letter cartridge ID in the
// middle of that code (NBA Showtime's code is N-SO-E).
const fsp = require('fs').promises;

const TITLE_OPTIONS = {
  // NBA Showtime: NBA on NBC. The emulator's own game list runs it with
  // "count per op" 1 (faster CPU timing); the generic 2 makes it lock up.
  SO: { 'mupen64plus-CountPerOp': '1' },
};

// Returns the first 64 bytes in cartridge (big-endian, ".z64") order, whatever
// order the file is in, or null when this isn't an N64 game.
function normalise(head) {
  if (!Buffer.isBuffer(head) || head.length < 64) return null;
  const out = Buffer.from(head.subarray(0, 64));
  const magic = out.readUInt32BE(0);
  if (magic === 0x80371240) return out; // .z64
  if (magic === 0x37804012) return out.swap16(); // .v64, byte-swapped
  if (magic === 0x40123780) return out.swap32(); // .n64, little-endian
  return null;
}

function parseHeader(head) {
  const h = normalise(head);
  if (!h) return null;
  const text = (from, to) => h.toString('latin1', from, to).replace(/[^\x20-\x7e]/g, ' ').trim();
  const gameCode = text(0x3b, 0x3f);
  return {
    name: text(0x20, 0x34),
    gameCode,
    cartId: h.toString('latin1', 0x3c, 0x3e),
    version: h[0x3f],
  };
}

async function readHeader(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buf, 0, 64, 0);
    return bytesRead === 64 ? parseHeader(buf) : null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close();
  }
}

// Emulator settings this game needs, as { optionKey: value }.
function optionsFor(header) {
  return { ...((header && TITLE_OPTIONS[header.cartId]) || {}) };
}

// Options come from games.json too ("options": { "key": "value" }). Only
// plain key/value text gets through to the emulator.
function cleanOptions(options) {
  const out = {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) return out;
  for (const [key, value] of Object.entries(options)) {
    const v = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
    if (typeof v !== 'string') continue;
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key) || !/^[\x20-\x7e]{1,80}$/.test(v)) continue;
    out[key] = v;
  }
  return out;
}

module.exports = { parseHeader, readHeader, optionsFor, cleanOptions, TITLE_OPTIONS };
