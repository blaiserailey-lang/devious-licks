// Keyboard and controller. Both end up as the same few commands:
// a direction, select (A), back (B), remove (X), picture (Y).
//
//   keyboard    arrows; Enter or A; Escape or B; X, Delete or Backspace; Y or P
//   controller  D-pad or left stick; A (0); B (1); X (2); Y (3)
//
// The controller is only read while this window is the one in use: the same
// controller plays the game in the game's own window.

const REPEAT_FIRST = 350; // a held direction repeats after this long...
const REPEAT_NEXT = 115; // ...and then this often

// Typing into a field is typing, not steering.
function typing(target) {
  if (!target || !target.tagName) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'file'].includes(target.type);
}

export function createInput(commands) {
  // ----- keyboard -----
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.isComposing || typing(e.target)) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (key === 'Escape' || (key === 'b' && !e.altKey)) {
        take();
        if (!e.repeat) commands.back();
        return;
      }
      // A button that is not part of the screen's own steering (a message's
      // button, say) is pressed the ordinary way.
      const native = e.target.closest && e.target.closest('[data-native]') && e.target.offsetParent !== null; // (and still in sight)
      if (key === 'Enter' || (key === 'a' && !e.altKey) || (e.altKey && e.code === 'KeyA')) {
        if (native && key === 'Enter') return;
        take();
        if (!e.repeat) commands.select({ reset: e.altKey, diagnose: e.shiftKey });
        return;
      }
      if (key === ' ' && native) return;
      if (e.altKey) return;
      if (key.startsWith('Arrow')) {
        take();
        commands.direction(key);
      } else if (key === 'x' || key === 'Delete' || key === 'Backspace') {
        take();
        if (!e.repeat) commands.remove();
      } else if (key === 'y' || key === 'p') {
        take();
        if (!e.repeat) commands.picture();
      } else if (key === '/' && commands.find) {
        take();
        commands.find();
      } else if (['Home', 'End', 'PageUp', 'PageDown'].includes(key) && commands.jump) {
        take();
        commands.jump(key);
      }
    },
    true
  );

  // ----- controller (the standard layout: A 0, B 1, X 2, Y 3, D-pad 12 to 15, left stick axes 0 and 1) -----
  let frame = 0;
  let allowed = true;
  let padIndex = null;
  let held = null; // which of A, B, X, Y were down at the last look (null: not looked yet)
  let heldDirection = '';
  let nextRepeat = 0;

  const listening = () => allowed && !document.hidden && document.hasFocus();

  function forget() {
    padIndex = null;
    held = null;
    heldDirection = '';
    nextRepeat = 0;
  }

  function poll(now) {
    frame = 0;
    if (!listening()) return forget();
    let pads;
    try {
      pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    } catch {
      allowed = false;
      return;
    }
    const pad = [...pads].find((p) => p && p.connected && p.mapping === 'standard');
    if (!pad) return forget(); // (plugging one in starts the looking again)
    if (padIndex !== pad.index) {
      padIndex = pad.index;
      heldDirection = '';
    }
    const pressed = (i) => Boolean(pad.buttons[i] && pad.buttons[i].pressed);
    let d = '';
    if (pressed(12)) d = 'ArrowUp';
    else if (pressed(13)) d = 'ArrowDown';
    else if (pressed(14)) d = 'ArrowLeft';
    else if (pressed(15)) d = 'ArrowRight';
    else {
      const x = pad.axes[0] || 0;
      const y = pad.axes[1] || 0;
      if (Math.max(Math.abs(x), Math.abs(y)) > 0.55) d = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'ArrowRight' : 'ArrowLeft') : y > 0 ? 'ArrowDown' : 'ArrowUp';
    }
    const now4 = [pressed(0), pressed(1), pressed(2), pressed(3)];
    if (held === null) {
      // The first look after coming back to this window: whatever is held
      // down now was pressed for the game, not for the menu.
      held = now4;
      heldDirection = d;
      nextRepeat = Infinity;
    } else {
      if (d && (d !== heldDirection || now >= nextRepeat)) {
        commands.direction(d);
        nextRepeat = now + (d === heldDirection ? REPEAT_NEXT : REPEAT_FIRST);
      }
      heldDirection = d;
      if (now4[1] && !held[1]) commands.back();
      else if (now4[0] && !held[0]) commands.select({});
      else if (now4[2] && !held[2]) commands.remove();
      else if (now4[3] && !held[3]) commands.picture();
      held = now4;
    }
    frame = requestAnimationFrame(poll);
  }

  // Starts or stops the looking. `connected`: a controller was just plugged in
  // (or pressed its first button), so that press counts.
  function resume(connected = false) {
    const wasLooking = frame !== 0;
    cancelAnimationFrame(frame);
    frame = 0;
    if (!listening()) return forget();
    if (!wasLooking) {
      forget();
      if (connected) held = [false, false, false, false];
    }
    frame = requestAnimationFrame(poll);
  }
  window.addEventListener('gamepadconnected', () => {
    allowed = true;
    resume(true);
  });
  window.addEventListener('gamepaddisconnected', forget);
  document.addEventListener('visibilitychange', () => resume());
  window.addEventListener('focus', () => resume());
  window.addEventListener('blur', () => resume());
  resume();
}
