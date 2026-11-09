// Copies EmulatorJS and the bundled emulator cores out of node_modules into
// vendor/emulatorjs/data so the app can run games fully offline.
// Runs automatically after `npm install`.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules', '@emulatorjs');
const out = path.join(root, 'vendor', 'emulatorjs', 'data');

// Cores bundled with the app. Add a core package to devDependencies and to
// this list to support another console.
const CORES = ['fceumm', 'snes9x', 'mgba', 'gambatte', 'genesis_plus_gx'];

const src = path.join(nm, 'emulatorjs', 'data');
if (!fs.existsSync(src)) {
  console.warn('[vendor] @emulatorjs/emulatorjs not installed, skipping.');
  process.exit(0);
}

fs.rmSync(path.join(root, 'vendor', 'emulatorjs'), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const entry of ['loader.js', 'emulator.css', 'version.json', 'src', 'compression', 'localization']) {
  fs.cpSync(path.join(src, entry), path.join(out, entry), { recursive: true });
}

const coresOut = path.join(out, 'cores');
fs.mkdirSync(path.join(coresOut, 'reports'), { recursive: true });
for (const core of CORES) {
  const dir = path.join(nm, `core-${core}`);
  if (!fs.existsSync(dir)) {
    console.warn(`[vendor] core ${core} missing; run npm install.`);
    continue;
  }
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('-wasm.data')) fs.copyFileSync(path.join(dir, f), path.join(coresOut, f));
  }
  const report = path.join(dir, 'reports', `${core}.json`);
  if (fs.existsSync(report)) fs.copyFileSync(report, path.join(coresOut, 'reports', `${core}.json`));
}
console.log(`[vendor] EmulatorJS + cores (${CORES.join(', ')}) copied to vendor/emulatorjs`);
