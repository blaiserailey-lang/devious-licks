// The backdrop of the Games screen: the wall of a dim green chamber, made of
// irregular cells, with slow wisps of light drifting across it.
import { still, awake, onAwakeChange } from './prefs.js';

export function createChamber({ root, library, canvas }) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { update() {} };
  let w = 1;
  let h = 1;
  let ratio = 1;
  let frame = 0;
  let last = 0;
  let time = 0;

  // The same wall every time: a fixed scatter of points, each given the patch
  // of wall that is nearer to it than to any other.
  let seed = 7843;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const sites = [];
  for (let y = -7; y <= 7; y++) for (let x = -10; x <= 10; x++) sites.push([(x + (y % 2) * 0.4 + (random() - 0.5) * 0.72) / 7, (y + (random() - 0.5) * 0.72) / 6]);
  const cells = sites
    .map((a, i) => {
      let poly = [[-1.9, -1.6], [1.9, -1.6], [1.9, 1.6], [-1.9, 1.6]];
      for (let j = 0; j < sites.length && poly.length; j++) {
        if (i === j) continue;
        const b = sites[j];
        const nx = b[0] - a[0];
        const ny = b[1] - a[1];
        const c = (b[0] * b[0] + b[1] * b[1] - a[0] * a[0] - a[1] * a[1]) / 2;
        const next = [];
        for (let k = 0; k < poly.length; k++) {
          const p = poly[k];
          const q = poly[(k + 1) % poly.length];
          const dp = p[0] * nx + p[1] * ny - c;
          const dq = q[0] * nx + q[1] * ny - c;
          if (dp <= 0) next.push(p);
          if (dp <= 0 !== dq <= 0) {
            const t = dp / (dp - dq);
            next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
          }
        }
        poly = next;
      }
      return { points: poly, shade: random() };
    })
    .filter((c) => c.points.length > 2);

  function project(x, y) {
    const shift = Math.sin(time * 0.055) * 0.018;
    const scale = 1 + 0.2 * (x * x * 0.55 + y * y * 0.4);
    return [w * (0.49 + (x * scale + shift) * 0.52), h * (0.48 + (y * scale + 0.06 * Math.sin(x * 2.0)) * 0.54)];
  }

  function draw() {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#020a00';
    ctx.fillRect(0, 0, w, h);
    const atmosphere = ctx.createRadialGradient(w * 0.35, h * 0.49, 5, w * 0.44, h * 0.47, w * 0.7);
    atmosphere.addColorStop(0, '#143600');
    atmosphere.addColorStop(0.48, '#0b2000');
    atmosphere.addColorStop(1, '#010900');
    ctx.fillStyle = atmosphere;
    ctx.fillRect(0, 0, w, h);
    for (const cell of cells) {
      const p = cell.points;
      ctx.beginPath();
      for (let j = 0; j < p.length; j++) {
        const a = p[j];
        const b = p[(j + 1) % p.length];
        for (let k = 0; k < 4; k++) {
          const f = k / 4;
          const xy = project(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
          if (j === 0 && k === 0) ctx.moveTo(xy[0], xy[1]);
          else ctx.lineTo(xy[0], xy[1]);
        }
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(45,110,0,${0.012 + cell.shade * 0.035})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(93,220,0,${0.14 + cell.shade * 0.12})`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    // The wisps follow the wall's curve and drift slowly.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let j = 0; j < 5; j++) {
      ctx.beginPath();
      for (let k = 0; k <= 100; k++) {
        const x = -1.6 + k * 0.032;
        const y = 0.57 * Math.sin(x * 1.8 + time * 0.055 + j * 0.68) + 0.3 * Math.sin(x * 0.7 - j) + 0.13 * (j - 2);
        const p = project(x, y);
        if (k === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      }
      ctx.strokeStyle = j % 2 ? '#7bff0012' : '#caff0018';
      ctx.lineWidth = j % 2 ? 6 : 1.2;
      ctx.stroke();
    }
    ctx.restore();
    // Dark in the middle, where the covers are; the wall shows most at the rim.
    const center = ctx.createRadialGradient(w * 0.53, h * 0.48, w * 0.05, w * 0.5, h * 0.5, w * 0.62);
    center.addColorStop(0, '#010900e8');
    center.addColorStop(0.4, '#010800bd');
    center.addColorStop(0.78, '#04100030');
    center.addColorStop(1, '#0000');
    ctx.fillStyle = center;
    ctx.fillRect(0, 0, w, h);
    const edge = ctx.createRadialGradient(w * 0.5, h * 0.48, Math.min(w, h) * 0.25, w * 0.5, h * 0.48, w * 0.7);
    edge.addColorStop(0, '#0000');
    edge.addColorStop(0.7, '#00000008');
    edge.addColorStop(1, '#000000bd');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, w, h);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    w = r.width;
    h = r.height;
    ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    draw();
  }

  const active = () => !root.dataset.transitioning && !library.hidden && library.dataset.screen === 'home' && awake() && !still();

  // (About fifteen pictures a second is plenty for something this slow.)
  function tick(now) {
    frame = 0;
    if (!active()) return;
    const dt = last ? Math.min((now - last) / 1000, 0.12) : 0.05;
    if (!last || now - last >= 65) {
      last = now;
      time += dt;
      draw();
    }
    frame = requestAnimationFrame(tick);
  }

  function update() {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    if (active()) frame = requestAnimationFrame(tick);
  }

  new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['data-transitioning'] });
  new MutationObserver(() => {
    if (!library.hidden && w <= 1) resize();
    update();
  }).observe(library, { attributes: true, attributeFilter: ['hidden', 'data-screen'] });
  new ResizeObserver(resize).observe(canvas);
  onAwakeChange(update);
  resize();
  return { update };
}
