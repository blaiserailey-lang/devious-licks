// The home screen's backdrop: a curved wire grid with a spark at every
// crossing, darkest in the middle where the orb and the menu sit. It is drawn
// once per size, not animated.
import { smooth } from './prefs.js';

export function createGrid(canvas, host) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  let w = 1;
  let h = 1;
  let ratio = 1;

  const project = (u, v) => [w * (0.5 + u * (0.5 - 0.115 * v * v)), h * (0.475 + v * (0.27 + 0.3 * u * u))];
  const exposure = (x, y) => smooth(0.34, 0.49, Math.abs(x / w - 0.5) + 0.24 * Math.pow(y / h - 0.475, 2));

  function curve(points) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const light = exposure((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (light < 0.002) continue;
      ctx.globalAlpha = light;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }

  function draw() {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000d00';
    ctx.fillRect(0, 0, w, h);
    const s = w / 1672;
    ctx.lineWidth = s;
    ctx.strokeStyle = '#65ec06';
    ctx.shadowColor = '#57ff00';
    ctx.shadowBlur = 3 * s;
    const us = Array.from({ length: 43 }, (_, i) => {
      const u = (i - 21) * 0.065;
      return u - Math.sign(u) * 0.02;
    });
    const vs = Array.from({ length: 31 }, (_, i) => (i - 15) * 0.1);
    for (const u of us) curve(Array.from({ length: 111 }, (_, i) => project(u, -1.4 + i * 0.028)));
    for (const v of vs) curve(Array.from({ length: 111 }, (_, i) => project(-1.4 + i * 0.028, v)));
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    // the sparks
    for (const u of us) {
      for (const v of vs) {
        const [x, y] = project(u, v);
        const light = exposure(x, y);
        if (light < 0.025 || x < 0 || x > w || y < 0 || y > h) continue;
        ctx.globalAlpha = light;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 12 * s);
        glow.addColorStop(0, '#ddff8ccc');
        glow.addColorStop(0.18, '#8bff0080');
        glow.addColorStop(1, '#65ff0000');
        ctx.fillStyle = glow;
        ctx.fillRect(x - 12 * s, y - 12 * s, 24 * s, 24 * s);
        ctx.fillStyle = '#e7ff9b';
        ctx.beginPath();
        ctx.moveTo(x, y - 6 * s);
        ctx.quadraticCurveTo(x + 1.4 * s, y - 1.4 * s, x + 5 * s, y);
        ctx.quadraticCurveTo(x + 1.4 * s, y + 1.4 * s, x, y + 6 * s);
        ctx.quadraticCurveTo(x - 1.4 * s, y + 1.4 * s, x - 5 * s, y);
        ctx.quadraticCurveTo(x - 1.4 * s, y - 1.4 * s, x, y - 6 * s);
        ctx.fill();
        ctx.fillStyle = '#f5ffc9';
        ctx.fillRect(x - 0.65 * s, y - 0.65 * s, 1.3 * s, 1.3 * s);
      }
    }
    ctx.globalAlpha = 1;
    // the bright arc that rises behind the A prompt
    const arc = () => {
      ctx.beginPath();
      ctx.moveTo(w * 0.44, h * 1.08);
      ctx.bezierCurveTo(w * 0.64, h * 1.0, w * 0.78, h * 0.49, w * 0.96, h * 1.04);
    };
    const glow = ctx.createLinearGradient(w * 0.51, 0, w * 0.97, 0);
    glow.addColorStop(0, '#6aff0000');
    glow.addColorStop(0.35, '#6aff0055');
    glow.addColorStop(0.62, '#b8ff22');
    glow.addColorStop(0.87, '#faffb0');
    glow.addColorStop(1, '#baff25');
    ctx.save();
    ctx.strokeStyle = glow;
    ctx.shadowColor = '#7bff00';
    ctx.shadowBlur = 26 * s;
    ctx.lineWidth = 3 * s;
    arc();
    ctx.stroke();
    ctx.shadowBlur = 12 * s;
    arc();
    ctx.stroke();
    ctx.restore();
  }

  function resize() {
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    w = r.width;
    h = r.height;
    ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    draw();
  }
  new ResizeObserver(resize).observe(host);
  resize();
}
