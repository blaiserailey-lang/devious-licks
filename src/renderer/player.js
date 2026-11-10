// Boots EmulatorJS (bundled in vendor/emulatorjs) for one game.
const params = new URLSearchParams(location.search);
document.title = params.get('title') || 'Devious Licks';

// Option-click on a game card starts it with the emulator's default settings,
// in case a changed setting stops the game from booting.
if (params.get('reset') === '1') {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`ejs-${params.get('saveId')}-`)) localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
}

window.EJS_player = '#game';
window.EJS_core = params.get('core');
window.EJS_gameName = params.get('title');
window.EJS_gameID = params.get('saveId');
window.EJS_gameUrl = params.get('romUrl');
const dataPath = new URL('../../vendor/emulatorjs/data/', location.href).href;
window.EJS_pathtodata = dataPath;
window.EJS_DEBUG_XX = true; // load the unminified sources that ship in the npm package
window.EJS_startOnLoaded = true;
window.EJS_color = '#ff3d7f';
window.EJS_backgroundColor = '#000000';
window.EJS_language = 'en-US';
window.EJS_disableAutoLang = true;

// Emulator settings this game needs (see src/n64.js), as core option values.
try {
  const options = JSON.parse(params.get('options') || 'null');
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    const clean = {};
    for (const [key, value] of Object.entries(options)) if (typeof value === 'string') clean[key] = value;
    if (Object.keys(clean).length) {
      window.EJS_defaultOptions = clean;
      setAtStartup(clean);
    }
  }
} catch { /* no options */ }

// EmulatorJS applies default options once the emulator core is running. That
// is too late for the ones a core reads only while it starts (the N64 CPU
// timing is one of those). The core's option file is written just before the
// core starts, from the player's saved settings, so the options a game needs
// are added to that file here.
function setAtStartup(options) {
  let emulator;
  Object.defineProperty(window, 'EJS_emulator', {
    configurable: true,
    enumerable: true,
    get: () => emulator,
    set(value) {
      emulator = value;
      if (!value || typeof value.getCoreSettings !== 'function') return;
      const saved = value.getCoreSettings.bind(value);
      value.getCoreSettings = () => {
        const lines = String(saved() || '').split('\n').filter((line) => line.trim() && !(line.split('=')[0].trim() in options));
        for (const [key, v] of Object.entries(options)) lines.push(`${key} = "${v}"`);
        return lines.join('\n') + '\n';
      };
    },
  });
}

const s = document.createElement('script');
s.src = dataPath + 'loader.js';
document.body.append(s);
