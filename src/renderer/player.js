// Boots EmulatorJS (bundled in vendor/emulatorjs) for one game.
const params = new URLSearchParams(location.search);
document.title = params.get('title') || 'Devious Licks';

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

const s = document.createElement('script');
s.src = dataPath + 'loader.js';
document.body.append(s);
