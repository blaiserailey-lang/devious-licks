// The camera's journey between the home screen and another screen.
//
// Going out (about 1.1 s): the home hub grows toward the viewer, the orb
// passes on the left and the menu leaves to the right; a small green cell
// hangs in the dark, swells past the camera, and the new screen is there.
// Coming home (about 1.08 s): the screen shrinks into the cell, a shell and
// a wire mesh pass by, and the orb and the menu settle.
// B during the way out turns the camera around.
import { clamp, smooth, easeOut, still } from './prefs.js';
import { paintCell } from './cell.js';

const OUT_MS = 1100;
const HOME_MS = 1080;

// How big the cell is (as a share of the stage's width) along the way.
const CELL_OUT = [[0, 0], [0.34, 0.03], [0.45, 0.051], [0.55, 0.063], [0.64, 0.092], [0.73, 0.139], [0.82, 0.395], [0.88, 1.1], [1, 1.8]];
const CELL_HOME = [[0, 0.5], [0.09, 0.143], [0.18, 0.045], [0.25, 0.043], [0.42, 0.035], [1, 0]];
function cellRadius(p, back) {
  const keys = back ? CELL_HOME : CELL_OUT;
  for (let i = 1; i < keys.length; i++) {
    if (p <= keys[i][0]) {
      const a = keys[i - 1];
      const b = keys[i];
      return a[1] + ((b[1] - a[1]) * (p - a[0])) / (b[0] - a[0]);
    }
  }
  return 0;
}

// The wire mesh the camera crosses on the way home.
function paintMesh() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 768;
  const c = canvas.getContext('2d');
  if (!c) return canvas;
  c.fillStyle = '#062400';
  c.fillRect(0, 0, 1024, 768);
  c.strokeStyle = '#89bb31';
  c.lineWidth = 1.5;
  c.shadowColor = '#609d0a';
  c.shadowBlur = 4;
  const point = (u, v) => [512 + u * (512 - 105 * v * v), 384 + v * (310 + 80 * u * u)];
  for (let j = -10; j <= 10; j++) {
    for (let axis = 0; axis < 2; axis++) {
      c.beginPath();
      for (let k = 0; k <= 70; k++) {
        const u = -1.5 + (k * 3) / 70;
        const p = axis ? point(u, j * 0.18) : point(j * 0.18, u);
        if (k) c.lineTo(p[0], p[1]);
        else c.moveTo(p[0], p[1]);
      }
      c.stroke();
    }
  }
  return canvas;
}

// view(name) gives the element of a screen; focusedArt() the picture of the
// game in front (or nothing); onArrive(name) is called when the camera stops.
export function createTravel({ root, scene, stage, flight, home, art, raster, view, focusedArt, onArrive }) {
  const ctx = flight.getContext('2d', { willReadFrequently: true });
  const cell = paintCell(640);
  const mesh = paintMesh();
  // What can be made out inside the cell: a faint, green-tinted glimpse.
  const glimpse = document.createElement('canvas');
  glimpse.width = glimpse.height = 640;
  const gc = glimpse.getContext('2d', { willReadFrequently: true });
  let transition = null;
  let frame = 0;

  function bakeGlimpse() {
    if (!gc) return;
    gc.clearRect(0, 0, 640, 640);
    const picture = focusedArt() || art;
    if (!picture || !picture.complete || !picture.naturalWidth) return;
    try {
      gc.save();
      gc.globalAlpha = 0.12;
      gc.filter = 'sepia(1) saturate(2) hue-rotate(35deg)';
      gc.drawImage(picture, 255, 224, 130, 192);
      gc.restore();
      gc.save();
      gc.globalCompositeOperation = 'destination-in';
      const mask = gc.createRadialGradient(320, 320, 45, 320, 320, 115);
      mask.addColorStop(0, '#fff');
      mask.addColorStop(1, '#fff0');
      gc.fillStyle = mask;
      gc.fillRect(0, 0, 640, 640);
      gc.restore();
    } catch {
      gc.clearRect(0, 0, 640, 640);
    }
  }

  function paint(p) {
    const t = transition;
    if (!t) return;
    const from = view(t.from);
    const to = view(t.to);
    if (!t.back) {
      const r = smooth(0.85, 0.97, p);
      to.style.transform = `scale(${0.94 + 0.06 * easeOut(r)})`;
      to.style.opacity = String(r);
      // (from a screen other than home, on the way to Games with a game just added: that screen fades out)
      if (t.from !== 'home') from.style.opacity = String(1 - smooth(0, 0.16, p));
    } else {
      from.style.transformOrigin = '53.25% 43%';
      from.style.transform = `scale(${1 - 0.95 * easeOut(p / 0.19)})`;
      from.style.opacity = String(1 - smooth(0.02, 0.15, p));
    }
    if (ctx) {
      const w = flight.width;
      const h = flight.height;
      // the stage (the 16:9 picture in the middle of the window), in the canvas's own measure
      const { x: sx, y: sy, w: sw, h: sh } = t.stage;
      ctx.clearRect(0, 0, w, h);
      if (t.back || t.from === 'home') raster.paint(ctx, p, t.back, w, h); // the home hub, when the flight leaves from it or ends at it
      if (t.back) {
        const pass = smooth(0.23, 0.38, p) * (1 - smooth(0.66, 0.78, p));
        if (pass > 0) {
          ctx.save();
          ctx.globalAlpha = pass * 0.55;
          ctx.globalCompositeOperation = 'screen';
          ctx.translate(w * (0.35 + 0.15 * p), h * 0.48);
          ctx.rotate(-0.4 + 0.35 * p);
          const zoom = 3.2 - 2.2 * smooth(0.3, 0.78, p);
          ctx.scale(zoom, zoom);
          ctx.drawImage(mesh, -w * 0.5, -h * 0.5, w, h);
          ctx.restore();
          ctx.save();
          ctx.globalAlpha = pass * 0.26;
          const r = sw * (0.66 - 0.13 * p);
          const x = sx + sw * (-0.27 + 0.14 * p);
          ctx.drawImage(cell, x - r, sy + sh * 0.48 - r, r * 2, r * 2);
          ctx.restore();
        }
        const ribbon = smooth(0.15, 0.22, p) * (1 - smooth(0.48, 0.65, p));
        if (ribbon > 0 && art.complete && art.naturalWidth) {
          ctx.globalAlpha = ribbon * 0.3;
          ctx.drawImage(art, sx + sw * (-1.5 + 0.2 * smooth(0.18, 0.45, p)), sy - sh * 0.3, sw * 1.6, sw * 1.6);
          ctx.globalAlpha = 1;
        }
        const band = smooth(0.28, 0.34, p) * (1 - smooth(0.39, 0.47, p));
        if (band > 0) {
          ctx.save();
          ctx.globalAlpha = band * 0.5;
          const light = ctx.createLinearGradient(0, 0, w * 0.7, h);
          light.addColorStop(0, '#427b00');
          light.addColorStop(0.5, '#83b625');
          light.addColorStop(1, '#1c4200');
          ctx.strokeStyle = light;
          ctx.lineWidth = w * 0.14;
          ctx.beginPath();
          ctx.moveTo(-w * 0.2, -h * 0.2);
          ctx.bezierCurveTo(w * 0.04, h * 0.25, w * 0.55, h * 0.5, w * 0.6, h * 1.2);
          ctx.stroke();
          ctx.restore();
        }
      }
      const alpha = t.back ? smooth(0, 0.07, p) * (1 - smooth(0.32, 0.46, p)) : smooth(0.3, 0.38, p) * (1 - smooth(0.87, 0.95, p));
      if (alpha > 0) {
        const radius = sw * cellRadius(p, t.back);
        const cx = sx + sw * (t.back ? 0.5325 : 0.4125);
        const cy = sy + sh * (t.back ? 0.43 : 0.342);
        if (t.back && p < 0.21) {
          ctx.globalAlpha = alpha * 0.35 * (1 - smooth(0.1, 0.21, p));
          const outer = radius * 2.55;
          ctx.drawImage(cell, cx - outer, cy - outer, outer * 2, outer * 2);
        }
        ctx.globalAlpha = alpha;
        ctx.drawImage(cell, cx - radius, cy - radius, radius * 2, radius * 2);
        ctx.globalAlpha = alpha * (1 - smooth(0.76, 0.87, p));
        ctx.drawImage(glimpse, cx - radius, cy - radius, radius * 2, radius * 2);
        ctx.globalAlpha = 1;
      }
    }
    root.dataset.flightProgress = p.toFixed(3);
  }

  function finish(name) {
    cancelAnimationFrame(frame);
    frame = 0;
    transition = null;
    delete root.dataset.transitioning;
    delete root.dataset.flightProgress;
    root.removeAttribute('aria-busy');
    flight.hidden = true;
    if (ctx) ctx.clearRect(0, 0, flight.width, flight.height);
    onArrive(name);
  }

  function tick(now) {
    frame = 0;
    const t = transition;
    if (!t) return;
    const dt = Math.min(80, now - t.last);
    t.last = now;
    t.p = clamp(t.p + (dt / t.duration) * (t.reverse ? -1 : 1));
    paint(t.p);
    if (t.reverse && t.p <= 0) return finish(t.from);
    if (!t.reverse && t.p >= 1) return finish(t.to);
    frame = requestAnimationFrame(tick);
  }

  // Takes the camera from the screen `from` to the screen `to`.
  function start(from, to, back) {
    if (transition) return;
    const bounds = scene.getBoundingClientRect();
    if (still() || !ctx || !bounds.width || !bounds.height) return finish(to);
    flight.width = Math.round(Math.min(bounds.width, 1400));
    flight.height = Math.round((flight.width * bounds.height) / bounds.width);
    flight.hidden = false;
    const k = flight.width / bounds.width;
    const a = view(from);
    const b = view(to);
    a.hidden = b.hidden = false;
    a.inert = b.inert = true;
    a.style.zIndex = '2';
    b.style.zIndex = '1';
    // (the stage can be measured now that the home screen is laid out)
    const laid = stage.getBoundingClientRect();
    const box = laid.width ? laid : bounds;
    bakeGlimpse();
    if (back || from === 'home') raster.bake();
    home.style.visibility = 'hidden';
    transition = {
      from, to, back, p: 0, last: performance.now(), duration: back ? HOME_MS : OUT_MS, reverse: false,
      stage: { x: (box.x - bounds.x) * k, y: (box.y - bounds.y) * k, w: box.width * k, h: box.height * k },
    };
    root.dataset.transitioning = back ? 'back' : 'open';
    root.setAttribute('aria-busy', 'true');
    paint(0);
    frame = requestAnimationFrame(tick);
  }

  return {
    start,
    get busy() {
      return Boolean(transition);
    },
    // B on the way out: turn around. Says whether it did.
    reverse() {
      if (!transition || transition.back || transition.reverse) return false;
      transition.reverse = true;
      return true;
    },
    // Ends the journey where it was heading, at once.
    settle() {
      if (transition) finish(transition.reverse ? transition.from : transition.to);
    },
  };
}
