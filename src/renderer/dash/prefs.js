// What the person chose in Settings: sound, volume, motion. Kept in the
// window's own storage; when that is not available the choices last until
// the window closes.

const KEY = 'devious-licks.dashboard';
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

const values = {
  sound: true,
  volume: 25, // 0..60, as hundredths of full loudness
  motion: null, // null: whatever the Mac's "Reduce motion" setting says
};

try {
  const saved = JSON.parse(window.localStorage.getItem(KEY) || '{}');
  if (typeof saved.sound === 'boolean') values.sound = saved.sound;
  if (Number.isFinite(saved.volume)) values.volume = Math.max(0, Math.min(60, saved.volume));
  if (typeof saved.motion === 'boolean') values.motion = saved.motion;
} catch {
  // nothing saved, or storage is off
}

const listeners = new Set();

export const prefs = {
  get sound() {
    return values.sound;
  },
  get volume() {
    return values.volume;
  },
  // Is motion on?
  get motion() {
    return values.motion === null ? !reduced.matches : values.motion;
  },
  set(name, value) {
    if (!(name in values) || values[name] === value) return;
    values[name] = value;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(values));
    } catch {
      // not saved; it still holds for now
    }
    for (const fn of listeners) fn(name);
  },
  onChange(fn) {
    listeners.add(fn);
  },
};

reduced.addEventListener('change', () => {
  if (values.motion === null) for (const fn of listeners) fn('motion');
});

// True when things should jump instead of move.
export const still = () => !prefs.motion;

// True while the window is the one being looked at and used. Canvases and
// sound rest otherwise (a game in its own window has the Mac to itself).
export const awake = () => !document.hidden && document.hasFocus();

// Calls fn whenever awake() may have changed.
export function onAwakeChange(fn) {
  document.addEventListener('visibilitychange', fn);
  window.addEventListener('focus', fn);
  window.addEventListener('blur', fn);
}

export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 3);
