#!/usr/bin/env node
// Builds two tiny, original N64 test cartridges for the player's self-test.
//
//   node make-n64-test-rom.js <output.z64>         the 2D cartridge
//   node make-n64-test-rom.js --3d <output.z64>    the 3D cartridge
//
// Neither contains any Nintendo code: the short programs below are written
// here, in machine code, and sit where a real cartridge keeps its boot code.
//
// The 2D cartridge paints a 320x240 picture itself, pixel by pixel: four
// coloured quarters (red, green / blue, white). The emulator only has to put
// that picture on screen.
//
// The 3D cartridge paints nothing itself. Like a real game, it hands the
// graphics chip a list of drawing commands on every frame: clear the picture
// and the depth buffer, then four squares made of triangles, one per quarter
// (yellow, cyan / magenta, and an orange one that gets its colour from a
// texture), and last a big green square that lies behind them. The green may
// only show where nothing is in front of it: in the cross-shaped gap between
// the four squares and as a thin frame around them. That takes the emulator
// through what a 3D game uses: triangles, shading, a texture and the depth
// buffer. It also plays a steady 1000 Hz tone through the sound chip, the way
// a game plays its sound: buffer after buffer.
//
// Both leave a few notes in memory for the self-test and then idle. Running
// them in the bundled N64 core checks the whole chain on a real Mac: core,
// OpenGL renderer and player.
// (Emulators with a simulated boot ROM run them; a real console would not.)
const fs = require('fs');

const R = { zero: 0, a0: 4, a1: 5, a2: 6, a3: 7, t0: 8, t1: 9, t2: 10, t3: 11, t4: 12, t5: 13, t6: 14 };

// A very small MIPS assembler: just the instructions the programs use.
function assembler() {
  const words = [];
  const labels = {};
  const branches = [];
  const emit = (w) => words.push(w >>> 0);
  const branch = (op, rs, rt, target) => { branches.push([words.length, target]); emit(op | (rs << 21) | (rt << 16)); };
  const a = {
    lui: (rt, imm) => emit(0x3c000000 | (rt << 16) | (imm & 0xffff)),
    ori: (rt, rs, imm) => emit(0x34000000 | (rs << 21) | (rt << 16) | (imm & 0xffff)),
    andi: (rt, rs, imm) => emit(0x30000000 | (rs << 21) | (rt << 16) | (imm & 0xffff)),
    addiu: (rt, rs, imm) => emit(0x24000000 | (rs << 21) | (rt << 16) | (imm & 0xffff)),
    sw: (rt, offset, base) => emit(0xac000000 | (base << 21) | (rt << 16) | (offset & 0xffff)),
    lw: (rt, offset, base) => emit(0x8c000000 | (base << 21) | (rt << 16) | (offset & 0xffff)),
    sh: (rt, offset, base) => emit(0xa4000000 | (base << 21) | (rt << 16) | (offset & 0xffff)),
    nop: () => emit(0),
    label: (name) => { labels[name] = words.length; },
    bne: (rs, rt, target) => branch(0x14000000, rs, rt, target),
    bltz: (rs, target) => branch(0x04000000, rs, 0, target), // branch if the top bit is set
    beq: (rs, rt, target) => branch(0x10000000, rs, rt, target),
    li: (rt, value) => {
      const hi = (value >>> 16) & 0xffff;
      const lo = value & 0xffff;
      if (hi) { a.lui(rt, hi); if (lo) a.ori(rt, rt, lo); } else a.ori(rt, R.zero, lo);
    },
    // The finished program. `limit` is how many bytes it may take.
    finish: (limit) => {
      for (const [at, target] of branches) words[at] = (words[at] | ((labels[target] - (at + 1)) & 0xffff)) >>> 0;
      if (words.length * 4 > limit) throw new Error('boot program too large');
      return words;
    },
  };
  return a;
}

const WIDTH = 320;
const HEIGHT = 240;
const FRAMEBUFFER = 0x00100000; // 1 MB into the console's memory
const NOTES = 0x400;            // where the programs leave their notes (see below)
const MARKER = 0xd1ceb00c;
const READ_BACK = [0x00, 0x04, 0x08, 0x18, 0x24, 0x28, 0x30, 0x34]; // status, address, width, lines per frame, columns, lines, x scale, y scale
const COUNTER = NOTES + 4 + READ_BACK.length * 4;

// The video chip: the standard 320x240 NTSC settings, 16-bit colour. Leaves
// the video chip's address in a0.
function videoSetup(a) {
  a.lui(R.a0, 0xa440);
  const vi = (offset, value) => { a.li(R.t0, value); a.sw(R.t0, offset, R.a0); };
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
}

// Notes for the self-test, in memory at NOTES: a marker ("got this far") and
// the video settings as the video chip reports them back. Leaves the address
// of the console's memory in a1. Each program adds a counter after these.
function leaveNotes(a) {
  a.lui(R.a1, 0xa000);
  a.li(R.t0, MARKER);
  a.sw(R.t0, NOTES, R.a1);
  READ_BACK.forEach((register, i) => { a.lw(R.t0, register, R.a0); a.sw(R.t0, NOTES + 4 + i * 4, R.a1); });
}

function romImage(words, name) {
  const rom = Buffer.alloc(0x100000);
  rom.writeUInt32BE(0x80371240, 0x00);  // cartridge signature
  rom.writeUInt32BE(0x0000000f, 0x04);
  rom.writeUInt32BE(0x80000400, 0x08);
  rom.writeUInt32BE(0x00001444, 0x0c);
  rom.write(name.padEnd(20, ' '), 0x20, 'ascii');
  rom.write('NDLE', 0x3b, 'ascii');     // game code, "E" = NTSC
  words.forEach((w, i) => rom.writeUInt32BE(w, 0x40 + i * 4));
  return rom;
}

// ---------------------------------------------------------------- 2D cartridge
function cartridge2d() {
  const a = assembler();
  const RED = 0xf801, GREEN = 0x07c1, BLUE = 0x003f, WHITE = 0xffff; // 5/5/5/1 colours

  // draw: two halves of 120 rows, each row 160 pixels of one colour then 160 of another
  a.lui(R.t0, 0xa000 | (FRAMEBUFFER >>> 16)); // t0 = where the next pixel goes
  a.addiu(R.t4, R.zero, 2);
  a.ori(R.t1, R.zero, RED);
  a.ori(R.t2, R.zero, GREEN);
  a.label('half');
  a.addiu(R.t5, R.zero, HEIGHT / 2);
  a.label('row');
  a.addiu(R.t6, R.zero, WIDTH / 2);
  a.label('left');
  a.sh(R.t1, 0, R.t0);
  a.addiu(R.t6, R.t6, -1);
  a.bne(R.t6, R.zero, 'left');
  a.addiu(R.t0, R.t0, 2); // (runs before the branch takes effect)
  a.addiu(R.t6, R.zero, WIDTH / 2);
  a.label('right');
  a.sh(R.t2, 0, R.t0);
  a.addiu(R.t6, R.t6, -1);
  a.bne(R.t6, R.zero, 'right');
  a.addiu(R.t0, R.t0, 2);
  a.addiu(R.t5, R.t5, -1);
  a.bne(R.t5, R.zero, 'row');
  a.nop();
  a.ori(R.t1, R.zero, BLUE);
  a.ori(R.t2, R.zero, WHITE);
  a.addiu(R.t4, R.t4, -1);
  a.bne(R.t4, R.zero, 'half');
  a.nop();

  videoSetup(a);
  leaveNotes(a);

  // idle, with a counter in the notes that keeps climbing
  a.ori(R.t3, R.zero, 0);
  a.label('idle');
  a.addiu(R.t3, R.t3, 1);
  a.beq(R.zero, R.zero, 'idle');
  a.sw(R.t3, COUNTER, R.a1); // (runs before the branch takes effect)

  const words = a.finish(0xfc0);
  return { rom: romImage(words, 'DL TEST CART'), words };
}

// ---------------------------------------------------------------- 3D cartridge
const DEPTH_BUFFER = 0x00140000; // right after the picture
const DATA = 0x00200000;         // where the drawing data below ends up in memory

// The data a game keeps next to its drawing commands, in the graphics chip's
// formats. Returns the block and the address of the command list inside it.
function drawingData() {
  const block = Buffer.alloc(0x800);
  let used = 0;
  const put = (bytes) => { // 8-byte aligned, like the real thing
    const at = used;
    bytes.copy(block, at);
    used = (at + bytes.length + 7) & ~7;
    if (used > block.length) throw new Error('drawing data too large');
    return DATA + at;
  };
  const s16 = (values) => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeInt16BE(v, i * 2)); return b; };

  // The emulator recognises which graphics microcode a game uses by a line of
  // text in the microcode's data. This cartridge has no microcode (the emulator
  // draws the commands itself), only that line: the name of the first, plain
  // "Fast3D" command set.
  const microcodeData = put(Buffer.from('RSP SW Version: 2.0D, 04-01-96\n\0', 'ascii'));

  // Where on the picture things land: the whole 320x240, depth 0..1022.
  const viewport = put(s16([WIDTH * 2, HEIGHT * 2, 511, 0, WIDTH * 2, HEIGHT * 2, 511, 0]));

  // A 4x4 matrix in the console's format: the whole parts of all 16 numbers,
  // then their fractions (65536ths).
  const matrix = (m) => {
    const b = Buffer.alloc(64);
    m.flat().forEach((v, i) => {
      const fixed = Math.round(v * 65536);
      b.writeInt16BE(fixed >> 16, i * 2);
      b.writeUInt16BE(fixed & 0xffff, 32 + i * 2);
    });
    return b;
  };
  // Corner coordinates run from -128 to 128 in every direction.
  const projection = put(matrix([[1 / 128, 0, 0, 0], [0, 1 / 128, 0, 0], [0, 0, 1 / 128, 0], [0, 0, 0, 1]]));
  const identity = put(matrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]));

  // One corner: position, texture coordinate (32nds of a texel), colour.
  const corner = (x, y, z, s, t, rgb) => {
    const b = Buffer.alloc(16);
    b.writeInt16BE(x, 0); b.writeInt16BE(y, 2); b.writeInt16BE(z, 4);
    b.writeInt16BE(s, 8); b.writeInt16BE(t, 10);
    b.writeUInt32BE(((rgb << 8) | 0xff) >>> 0, 12);
    return b;
  };
  // A square from (x0, y0) to (x1, y1), y up, at depth z (smaller is nearer).
  const square = (x0, y0, x1, y1, z, rgb) => Buffer.concat([
    corner(x0, y1, z, 0, 0, rgb), corner(x1, y1, z, 7 * 32, 0, rgb),
    corner(x1, y0, z, 7 * 32, 7 * 32, rgb), corner(x0, y0, z, 0, 7 * 32, rgb),
  ]);
  const NEAR = -32, FAR = 32;
  const shaded = put(Buffer.concat([
    square(-120, 16, -16, 120, NEAR, 0xffff00),   // top left: yellow
    square(16, 16, 120, 120, NEAR, 0x00ffff),     // top right: cyan
    square(-120, -120, -16, -16, NEAR, 0xff00ff), // bottom left: magenta
  ]));
  const textured = put(square(16, -120, 120, -16, NEAR, 0xffffff)); // bottom right: takes its colour from the texture
  // Behind all four and drawn after them: shows only in the gap between them
  // (the middle of the picture) and around them.
  const behind = put(square(-124, -124, 124, 124, FAR, 0x00c000));

  // An 8x8 texture, every texel the same orange (5/5/5/1).
  const ORANGE = 0xfc01;
  const texture = put(s16(new Array(64).fill(ORANGE - 0x10000)));

  // The command list, in the plain Fast3D command set. Two words per command.
  const list = [];
  const cmd = (w0, w1 = 0) => list.push(w0 >>> 0, w1 >>> 0);
  const wholePicture = () => cmd(0xf6000000 | (((WIDTH - 1) * 4) << 12) | ((HEIGHT - 1) * 4), 0); // fill rectangle
  const triangles = (first, squares) => {
    for (let q = 0; q < squares; q++) {
      const v = first + q * 4;
      cmd(0xbf000000, (v * 10 << 16) | ((v + 1) * 10 << 8) | ((v + 2) * 10));
      cmd(0xbf000000, (v * 10 << 16) | ((v + 2) * 10 << 8) | ((v + 3) * 10));
    }
  };
  const corners = (address, count) => cmd(0x04000000 | ((count - 1) << 20) | (count * 16), address);
  const SHADE_ONLY = [0xfcffffff, 0xfffe793c], TEXTURE_ONLY = [0xfcffffff, 0xfffcf87c];

  cmd(0xfe000000, DEPTH_BUFFER);                 // this is the depth buffer
  cmd(0xed000000, ((WIDTH * 4) << 12) | (HEIGHT * 4)); // draw anywhere on the picture
  // clear the depth buffer: point the picture at it for a moment and fill it with "far away"
  cmd(0xff100000 | (WIDTH - 1), DEPTH_BUFFER);
  cmd(0xef300000, 0);                            // fill mode
  cmd(0xf7000000, 0xfffcfffc);
  wholePicture();
  cmd(0xe7000000);                               // (wait for the pipeline)
  // clear the picture to dark purple
  cmd(0xff100000 | (WIDTH - 1), FRAMEBUFFER);
  cmd(0xf7000000, 0x40114011);
  wholePicture();
  cmd(0xe7000000);
  // three quarters: smooth-shaded, depth-tested triangles
  cmd(0xef082c00, 0x00552230);                   // normal drawing, opaque surfaces with depth test
  cmd(...SHADE_ONLY);
  cmd(0xb7000000, 0x00000205);                   // depth test, shading, smooth
  cmd(0x03800010, viewport);
  cmd(0x01030040, projection);
  cmd(0x01020040, identity);
  corners(shaded, 12);
  triangles(0, 3);
  // the fourth quarter: the same, coloured by the texture
  cmd(0xbb000001, 0xffffffff);                   // texturing on
  cmd(0xfd100000, texture);
  cmd(0xf5100000, 0x07000000);                   // load it...
  cmd(0xe6000000);
  cmd(0xf3000000, 0x07000000 | (63 << 12) | 0x400);
  cmd(0xe7000000);
  cmd(0xf5100400, 0x0000c030);                   // ...and use it as an 8x8 that repeats
  cmd(0xf2000000, (28 << 12) | 28);
  cmd(...TEXTURE_ONLY);
  corners(textured, 4);
  triangles(0, 1);
  cmd(0xbb000000, 0xffffffff);                   // texturing off
  cmd(...SHADE_ONLY);
  // the square behind them
  corners(behind, 4);
  triangles(0, 1);
  cmd(0xe9000000);                               // done drawing
  cmd(0xb8000000);                               // end of list
  const commands = Buffer.alloc(list.length * 4);
  list.forEach((w, i) => commands.writeUInt32BE(w, i * 4));
  const commandList = put(commands);

  return { block: block.subarray(0, used), microcodeData, commandList, commandBytes: commands.length };
}

// The sound: 1024 samples (about a 30th of a second at 32 kHz) of a square
// wave, 32 samples per cycle, which makes a 1000 Hz tone. Both ears get the
// same, at a quarter of full volume.
const SOUND = 0x00210000; // where it ends up in memory
function soundData() {
  const samples = Buffer.alloc(1024 * 4);
  for (let i = 0; i < 1024; i++) {
    const level = i % 32 < 16 ? 8192 : -8192;
    samples.writeInt16BE(level, i * 4);
    samples.writeInt16BE(level, i * 4 + 2);
  }
  return samples;
}

function cartridge3d() {
  const data = drawingData();
  const sound = soundData();
  const DATA_IN_ROM = 0x1000, SOUND_IN_ROM = 0x2000;
  const a = assembler();

  // copy the drawing data and the sound from the cartridge into memory
  const copy = (name, from, to, bytes) => {
    a.li(R.t0, 0xb0000000 | from);
    a.li(R.t1, 0xa0000000 | to);
    a.addiu(R.t2, R.zero, bytes / 4);
    a.label(name);
    a.lw(R.t3, 0, R.t0);
    a.sw(R.t3, 0, R.t1);
    a.addiu(R.t0, R.t0, 4);
    a.addiu(R.t2, R.t2, -1);
    a.bne(R.t2, R.zero, name);
    a.addiu(R.t1, R.t1, 4); // (runs before the branch takes effect)
  };
  copy('copy drawing data', DATA_IN_ROM, DATA, data.block.length);
  copy('copy sound', SOUND_IN_ROM, SOUND, sound.length);

  videoSetup(a);
  leaveNotes(a);

  // The sound chip: 16-bit stereo at 32 kHz (the video clock divided by 1521).
  a.lui(R.t4, 0xa450);
  const ai = (offset, value) => { a.li(R.t0, value); a.sw(R.t0, offset, R.t4); };
  ai(0x08, 1);     // on
  ai(0x10, 1520);  // sample rate
  ai(0x14, 15);    // 16 bits
  a.li(R.t5, SOUND);
  a.li(R.t6, sound.length);

  // Every time the video chip says a frame is over: acknowledge it, start the
  // graphics task (the job description is further down, at 0xfc0), count it,
  // and top up the sound.
  a.lui(R.a2, 0xa430);              // interrupt flags
  a.lui(R.a3, 0xa404);              // graphics processor control
  a.ori(R.t3, R.zero, 0);
  a.label('wait');
  a.lw(R.t0, 8, R.a2);
  a.andi(R.t0, R.t0, 8);            // has a frame ended?
  a.beq(R.t0, R.zero, 'wait');
  a.nop();
  a.sw(R.zero, 0x10, R.a0);         // acknowledge
  a.addiu(R.t1, R.zero, 5);
  a.sw(R.t1, 0x10, R.a3);           // go
  a.lw(R.t0, 0x10, R.a3);
  a.sw(R.t0, COUNTER + 4, R.a1);    // note: the graphics processor's status after the task
  a.addiu(R.t3, R.t3, 1);
  a.sw(R.t3, COUNTER, R.a1);        // note: tasks started so far
  // Keep the sound chip fed. It holds one buffer besides the one it is playing.
  a.lw(R.t0, 0x0c, R.t4);
  a.sw(R.t0, COUNTER + 8, R.a1);    // note: the sound chip's status
  a.bltz(R.t0, 'wait');             // both places taken: nothing to add this frame
  a.nop();
  a.sw(R.t5, 0x00, R.t4);           // where the samples are
  a.beq(R.zero, R.zero, 'wait');
  a.sw(R.t6, 0x04, R.t4);           // how many bytes: this queues them (runs before the branch takes effect)

  const words = a.finish(0xfc0 - 0x40);
  const rom = romImage(words, 'DL TEST CART 3D');

  // The job description for the graphics processor. The boot code area of a
  // cartridge is copied to the processor's own memory at power-on, and this
  // is where in that memory it looks for its task.
  const task = {
    0xfc0: 1,                 // a graphics task
    0xfc8: DATA + 0x1000, 0xfcc: 0xd0,          // boot microcode (unused: the emulator draws the list itself)
    0xfd0: DATA + 0x1000, 0xfd4: 0x1000,        // microcode (unused, all zero)
    0xfd8: data.microcodeData, 0xfdc: 0x800,    // microcode data: the name the emulator looks for
    0xfe0: DATA + 0x2000, 0xfe4: 0x400,         // matrix stack
    0xff0: data.commandList, 0xff4: data.commandBytes,
  };
  for (const [offset, value] of Object.entries(task)) rom.writeUInt32BE(value, Number(offset));
  data.block.copy(rom, DATA_IN_ROM);
  sound.copy(rom, SOUND_IN_ROM);
  return { rom, words };
}

const args = process.argv.slice(2);
const threeD = args[0] === '--3d';
if (threeD) args.shift();
const { rom, words } = threeD ? cartridge3d() : cartridge2d();
if (args[0] === '--hex') {
  process.stdout.write(words.map((w) => w.toString(16).padStart(8, '0')).join('\n') + '\n');
} else if (args[0]) {
  fs.writeFileSync(args[0], rom);
  console.log(`wrote ${args[0]} (${words.length} instructions)`);
} else {
  console.error('usage: make-n64-test-rom.js [--3d] <output.z64>');
  process.exit(2);
}
