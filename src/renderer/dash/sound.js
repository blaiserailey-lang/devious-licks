// The dashboard's sounds: one ambience loop and three short cues.
//
// THE SOUNDS ARE DEFINED HERE, and only here. To change one, replace its file
// in dash/audio/ (wav, ogg or mp3 all work) and, if the name changes, the
// `file` below. `gain` is how loud it plays against the others.
const SOUNDS = {
  ambience: { file: 'audio/ambience.wav', gain: 0.33, loop: true },
  focus: { file: 'audio/focus.wav', gain: 0.67 },
  select: { file: 'audio/select.wav', gain: 0.8 },
  back: { file: 'audio/back.wav', gain: 0.8 },
};

import { prefs, awake, onAwakeChange } from './prefs.js';

let context = null;
let master = null;
let loop = null;
let loading = null;
const buffers = {};
const playing = new Set();
let wanted = null; // a cue asked for while the sounds were still loading

async function load(name) {
  try {
    const res = await fetch(new URL(SOUNDS[name].file, import.meta.url));
    if (!res.ok) return;
    buffers[name] = await context.decodeAudioData(await res.arrayBuffer());
  } catch {
    // a sound that can't be loaded is a sound that isn't played
  }
}

function startLoop() {
  if (loop || !buffers.ambience) return;
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffers.ambience;
  source.loop = true;
  gain.gain.value = SOUNDS.ambience.gain;
  source.connect(gain);
  gain.connect(master);
  source.onended = () => gain.disconnect();
  source.start();
  loop = source;
}

function stopLoop() {
  if (!loop) return;
  try {
    loop.stop();
  } catch {
    // it had not started
  }
  loop.disconnect();
  loop = null;
}

// Brings the sound to where it should be: playing while the window is in
// use and sound is on, silent otherwise.
async function settle() {
  if (!context) return;
  try {
    if (prefs.sound && awake()) {
      await context.resume();
      if (context.state === 'running' && prefs.sound && awake()) startLoop();
    } else {
      stopLoop();
      for (const source of playing) {
        try {
          source.stop();
        } catch {
          // already over
        }
      }
      await context.suspend();
    }
  } catch {
    // no sound, then
  }
}

// Sound may only start once the person has clicked or pressed something.
// Every such moment calls this; the first one sets things up.
export function unlock() {
  if (!prefs.sound) return;
  if (context) {
    if (context.state !== 'running') settle();
    return;
  }
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    context = new Context();
    master = context.createGain();
    master.gain.value = prefs.volume / 100;
    master.connect(context.destination);
    loading = Promise.all(Object.keys(SOUNDS).map(load)).then(async () => {
      loading = null;
      await settle();
      if (wanted && performance.now() - wanted.at < 1500) cue(wanted.name);
      wanted = null;
    });
  } catch {
    context = null;
  }
}

// Plays one of the short sounds: 'focus', 'select' or 'back'.
export function cue(name) {
  if (!prefs.sound || !SOUNDS[name] || SOUNDS[name].loop) return;
  if (!context || loading) {
    wanted = { name, at: performance.now() };
    return;
  }
  if (!awake() || !buffers[name] || context.state !== 'running') return;
  try {
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffers[name];
    gain.gain.value = SOUNDS[name].gain;
    source.connect(gain);
    gain.connect(master);
    playing.add(source);
    source.onended = () => {
      playing.delete(source);
      gain.disconnect();
      source.disconnect();
    };
    source.start();
  } catch {
    // no sound, then
  }
}

// For the checks: what the sound is doing right now.
export function soundState() {
  return { context: context ? context.state : 'none', loop: Boolean(loop), loaded: Object.keys(buffers) };
}

prefs.onChange((name) => {
  if (name === 'volume' && master) master.gain.setTargetAtTime(prefs.volume / 100, context.currentTime, 0.04);
  if (name === 'sound') {
    if (prefs.sound && !context) unlock(); // (switching it on in Settings is itself a click or a key press)
    else settle();
  }
});
onAwakeChange(settle);
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, unlock, { capture: true, passive: true });
