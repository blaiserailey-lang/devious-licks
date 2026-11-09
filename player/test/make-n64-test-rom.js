#!/usr/bin/env node
// Builds a tiny, original N64 test cartridge for the player's self-test.
//
//   node make-n64-test-rom.js <output.z64>
//
// It contains no Nintendo code: the short program below is written here, in
// machine code, and sits where a real cartridge keeps its boot code. It fills
// a 320x240 picture with four coloured quarters (red, green / blue, white),
// points the video chip at it, leaves a few notes in memory for the self-test
// and then idles. Running it in the bundled N64 core checks the whole chain on
// a real Mac: core, OpenGL renderer and player.
// (Emulators with a simulated boot ROM run it; a real console would not.)
const fs = require('fs');

const R = { zero: 0, a0: 4, a1: 5, t0: 8, t1: 9, t2: 10, t3: 11, t4: 12, t5: 13, t6: 14 };
const words = [];
const labels = {};
const branches = [];
const emit = (w) => words.push(w >>> 0);
const lui = (rt, imm) => emit(0x3c000000 | (rt << 16) | (imm & 0xffff));
const ori = (rt, rs, imm) => emit(0x34000000 | (rs << 21) | (rt << 16) | (imm & 0xffff));
const addiu = (rt, rs, imm) => emit(0x24000000 | (rs << 21) | (rt << 16) | (imm & 0xffff));
const sw = (rt, offset, base) => emit(0xac000000 | (base << 21) | (rt << 16) | (offset & 0xffff));
const lw = (rt, offset, base) => emit(0x8c000000 | (base << 21) | (rt << 16) | (offset & 0xffff));
const sh = (rt, offset, base) => emit(0xa4000000 | (base << 21) | (rt << 16) | (offset & 0xffff));
const nop = () => emit(0);
const label = (name) => { labels[name] = words.length; };
const branch = (op, rs, rt, target) => { branches.push([words.length, target]); emit(op | (rs << 21) | (rt << 16)); };
const bne = (rs, rt, target) => branch(0x14000000, rs, rt, target);
const beq = (rs, rt, target) => branch(0x10000000, rs, rt, target);
const li = (rt, value) => {
  const hi = (value >>> 16) & 0xffff;
  const lo = value & 0xffff;
  if (hi) { lui(rt, hi); if (lo) ori(rt, rt, lo); } else ori(rt, R.zero, lo);
};

const WIDTH = 320;
const HEIGHT = 240;
const FRAMEBUFFER = 0x00100000; // 1 MB into the console's memory
const RED = 0xf801, GREEN = 0x07c1, BLUE = 0x003f, WHITE = 0xffff; // 5/5/5/1 colours
const NOTES = 0x400;          // where the program leaves its notes (see below)
const MARKER = 0xd1ceb00c;
const READ_BACK = [0x00, 0x04, 0x08, 0x18, 0x24, 0x28, 0x30, 0x34]; // status, address, width, lines per frame, columns, lines, x scale, y scale

// --- draw: two halves of 120 rows, each row 160 pixels of one colour then 160 of another
lui(R.t0, 0xa000 | (FRAMEBUFFER >>> 16)); // t0 = where the next pixel goes
addiu(R.t4, R.zero, 2);
ori(R.t1, R.zero, RED);
ori(R.t2, R.zero, GREEN);
label('half');
addiu(R.t5, R.zero, HEIGHT / 2);
label('row');
addiu(R.t6, R.zero, WIDTH / 2);
label('left');
sh(R.t1, 0, R.t0);
addiu(R.t6, R.t6, -1);
bne(R.t6, R.zero, 'left');
addiu(R.t0, R.t0, 2); // (runs before the branch takes effect)
addiu(R.t6, R.zero, WIDTH / 2);
label('right');
sh(R.t2, 0, R.t0);
addiu(R.t6, R.t6, -1);
bne(R.t6, R.zero, 'right');
addiu(R.t0, R.t0, 2);
addiu(R.t5, R.t5, -1);
bne(R.t5, R.zero, 'row');
nop();
ori(R.t1, R.zero, BLUE);
ori(R.t2, R.zero, WHITE);
addiu(R.t4, R.t4, -1);
bne(R.t4, R.zero, 'half');
nop();

// --- video chip: the standard 320x240 NTSC settings, 16-bit colour
lui(R.a0, 0xa440);
const vi = (offset, value) => { li(R.t0, value); sw(R.t0, offset, R.a0); };
vi(0x00, 0x00000302);   // 16-bit pixels, no filtering
vi(0x04, FRAMEBUFFER);  // picture address
vi(0x08, WIDTH);
vi(0x0c, 0x200);        // interrupt line
vi(0x10, 0);            // clear any pending interrupt
vi(0x14, 0x03e52239);   // burst
vi(0x1c, 0x00000c15);   // line length
vi(0x20, 0x0c150c15);
vi(0x24, 0x006c02ec);   // visible columns
vi(0x28, 0x002501ff);   // visible lines
vi(0x2c, 0x000e0204);
vi(0x30, 0x200);        // 320 pixels across
vi(0x34, 0x400);        // 240 lines down
vi(0x18, 0x0000020d);   // lines per frame: written last, this starts the frame clock

// --- notes for the self-test, in memory at NOTES: a marker ("got this far"),
// the video settings as the video chip reports them back, and a counter that
// keeps climbing while the program idles
lui(R.a1, 0xa000);
li(R.t0, MARKER);
sw(R.t0, NOTES, R.a1);
READ_BACK.forEach((register, i) => { lw(R.t0, register, R.a0); sw(R.t0, NOTES + 4 + i * 4, R.a1); });
ori(R.t3, R.zero, 0);
label('idle');
addiu(R.t3, R.t3, 1);
beq(R.zero, R.zero, 'idle');
sw(R.t3, NOTES + 4 + READ_BACK.length * 4, R.a1); // (runs before the branch takes effect)

for (const [at, target] of branches) words[at] = (words[at] | ((labels[target] - (at + 1)) & 0xffff)) >>> 0;
if (words.length * 4 > 0xfc0) throw new Error('boot program too large');

const rom = Buffer.alloc(0x100000);
rom.writeUInt32BE(0x80371240, 0x00);  // cartridge signature
rom.writeUInt32BE(0x0000000f, 0x04);
rom.writeUInt32BE(0x80000400, 0x08);
rom.writeUInt32BE(0x00001444, 0x0c);
rom.write('DL TEST CART'.padEnd(20, ' '), 0x20, 'ascii');
rom.write('NDLE', 0x3b, 'ascii');     // game code, "E" = NTSC
words.forEach((w, i) => rom.writeUInt32BE(w, 0x40 + i * 4));

if (process.argv[2] === '--hex') {
  process.stdout.write(words.map((w) => w.toString(16).padStart(8, '0')).join('\n') + '\n');
} else if (process.argv[2]) {
  fs.writeFileSync(process.argv[2], rom);
  console.log(`wrote ${process.argv[2]} (${words.length} instructions)`);
} else {
  console.error('usage: make-n64-test-rom.js <output.z64>');
  process.exit(2);
}
