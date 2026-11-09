const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseHeader, readHeader, optionsFor, cleanOptions } = require('../src/n64');

function header(code, name = 'SOME GAME') {
  const h = Buffer.alloc(64);
  h.writeUInt32BE(0x80371240, 0);
  h.write(name.padEnd(20, ' '), 0x20, 'latin1');
  h.write(code, 0x3b, 'latin1');
  return h;
}

test('reads the game code in every byte order', () => {
  const z64 = header('NSOE', 'NBA SHOWTIME');
  const v64 = Buffer.from(z64).swap16();
  const n64 = Buffer.from(z64).swap32();
  for (const h of [z64, v64, n64]) {
    const info = parseHeader(h);
    assert.strictEqual(info.name, 'NBA SHOWTIME');
    assert.strictEqual(info.gameCode, 'NSOE');
    assert.strictEqual(info.cartId, 'SO');
  }
  assert.strictEqual(z64.readUInt32BE(0), 0x80371240, 'input is left untouched');
  assert.strictEqual(parseHeader(Buffer.alloc(64)), null);
  assert.strictEqual(parseHeader(Buffer.alloc(10)), null);
});

test('a reskinned NBA Showtime gets its timing setting, other games get none', () => {
  assert.deepStrictEqual(optionsFor(parseHeader(header('NSOE'))), { 'mupen64plus-CountPerOp': '1' });
  assert.deepStrictEqual(optionsFor(parseHeader(header('NZZE'))), {});
  assert.deepStrictEqual(optionsFor(null), {});
});

test('only plain key/value options get through', () => {
  assert.deepStrictEqual(
    cleanOptions({ 'mupen64plus-CountPerOp': 1, 'mupen64plus-aspect': '16:9', 'bad key': 'x', nested: { a: 1 }, line: 'a\nb', flag: true }),
    { 'mupen64plus-CountPerOp': '1', 'mupen64plus-aspect': '16:9', flag: 'true' },
  );
  assert.deepStrictEqual(cleanOptions(null), {});
  assert.deepStrictEqual(cleanOptions(['a']), {});
});

test('the self-test cartridge is a valid N64 header and is not mistaken for a known game', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-n64-'));
  const rom = path.join(dir, 'test.z64');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'player', 'test', 'make-n64-test-rom.js'), rom]);
  assert.strictEqual(fs.statSync(rom).size, 0x100000);
  const info = await readHeader(rom);
  assert.strictEqual(info.name, 'DL TEST CART');
  assert.strictEqual(info.gameCode, 'NDLE');
  assert.deepStrictEqual(optionsFor(info), {});
  assert.strictEqual(await readHeader(path.join(dir, 'missing.z64')), null);
});
