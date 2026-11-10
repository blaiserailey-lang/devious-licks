// Flat pictures of the home screen, used only while the camera travels to or
// from another screen. Scaling the live menu itself is far too slow (every
// glow is redrawn each frame), so the screen is painted once into four layers
// (the grid, the orb, the menu, the prompt) and those are moved instead.
import { smooth, easeOut } from './prefs.js';

export function createRaster({ scene, stage, grid, core, art, items, prompt, version }) {
  let layers = {};
  let width = 1;
  let height = 1;
  let frame = { x: 0, y: 0, w: 1, h: 1 }; // where the stage is within the scene
  const node = new Image();
  node.src = new URL('art/node.webp', import.meta.url).href;
  node.decode?.().catch(() => {});

  function layer() {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function bar(c, x, y, w, h) {
    const a = Math.min(h * 0.25, w * 0.025);
    c.beginPath();
    c.moveTo(x + a, y);
    c.lineTo(x + w - a, y);
    c.lineTo(x + w, y + a);
    c.lineTo(x + w, y + h - a);
    c.lineTo(x + w - a, y + h);
    c.lineTo(x + a, y + h);
    c.lineTo(x, y + h - a);
    c.lineTo(x, y + a);
    c.closePath();
  }

  function bake() {
    const bounds = scene.getBoundingClientRect();
    width = Math.max(1, Math.round(bounds.width));
    height = Math.max(1, Math.round(bounds.height));
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x - bounds.x, y: r.y - bounds.y, w: r.width, h: r.height };
    };
    frame = rect(stage);
    const unit = frame.w; // the menu's sizes follow the stage's width
    layers = { environment: layer(), core: layer(), menu: layer(), prompt: layer() };
    const options = { willReadFrequently: true };
    if (grid.width > 1) layers.environment.getContext('2d', options).drawImage(grid, 0, 0, width, height);
    const cr = rect(core);
    if (art.complete && art.naturalWidth) layers.core.getContext('2d', options).drawImage(art, cr.x, cr.y, cr.w, cr.h);

    const c = layers.menu.getContext('2d', options);
    for (const item of items) {
      const disc = item.querySelector('.dn-disc');
      const barEl = item.querySelector('.dn-bar');
      const label = item.querySelector('.dn-label');
      const dr = rect(disc);
      const br = rect(barEl);
      const cs = getComputedStyle(barEl);
      const ls = getComputedStyle(label);
      const on = item.getAttribute('aria-pressed') === 'true';
      if (node.complete && node.naturalWidth) {
        const ds = getComputedStyle(disc);
        const m = new DOMMatrix(ds.transform);
        const dw = parseFloat(ds.width);
        const dh = parseFloat(ds.height);
        c.save();
        c.translate(dr.x + dr.w / 2, dr.y + dr.h / 2);
        c.rotate(Math.atan2(m.b, m.a));
        c.drawImage(node, -dw / 2, -dh / 2, dw, dh);
        c.restore();
      }
      // the thin line from the disc to the bar
      c.save();
      c.lineWidth = unit / 1280;
      c.strokeStyle = '#d8ff87';
      c.shadowColor = '#8fff1a';
      c.shadowBlur = unit * 0.003;
      const lx = dr.x + dr.w * 0.78;
      const ly = br.y - br.h * 0.56;
      c.beginPath();
      c.moveTo(lx, ly + br.h * 0.35);
      c.lineTo(lx + br.h * 0.2, ly);
      c.lineTo(lx + br.h * 0.55, ly);
      c.lineTo(lx + br.h * 0.75, ly + br.h * 0.43);
      c.lineTo(br.x, br.y - br.h * 0.12);
      c.lineTo(br.x + br.w * 0.08, br.y - br.h * 0.12);
      c.stroke();
      c.beginPath();
      c.arc(lx + br.h * 0.22, ly + br.h * 0.22, unit * 0.002, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(br.x - br.h * 0.24, br.y + br.h * 0.14);
      c.lineTo(br.x - br.h * 0.24, br.y + br.h * 0.63);
      c.lineTo(br.x, br.y + br.h * 0.85);
      c.stroke();
      c.restore();
      // the bar
      c.save();
      bar(c, br.x, br.y, br.w, br.h);
      const fill = c.createLinearGradient(br.x, 0, br.x + br.w, 0);
      if (on) {
        fill.addColorStop(0, '#f1ff2c');
        fill.addColorStop(0.35, '#e3fa00');
        fill.addColorStop(0.65, '#91ba00');
        fill.addColorStop(1, '#286b00');
      } else {
        fill.addColorStop(0, '#012a00');
        fill.addColorStop(0.75, '#002600');
        fill.addColorStop(1, '#1f6400');
      }
      c.fillStyle = fill;
      c.shadowColor = on ? '#c6f710' : '#72ff00';
      c.shadowBlur = unit * (on ? 0.009 : 0.004);
      c.fill();
      c.strokeStyle = on ? '#ffffa1' : '#b1ff40';
      c.lineWidth = unit * 0.0012;
      c.stroke();
      c.shadowBlur = 0;
      c.clip();
      const rim = c.createLinearGradient(0, br.y, 0, br.y + br.h);
      rim.addColorStop(0, on ? '#ffffbd' : '#b1ff81');
      rim.addColorStop(0.22, '#b1ff0000');
      rim.addColorStop(0.72, '#b1ff0000');
      rim.addColorStop(1, on ? '#f6ff96' : '#7eff3b');
      c.fillStyle = rim;
      c.fillRect(br.x, br.y, br.w, br.h);
      c.restore();
      // its words
      c.save();
      c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      c.fillStyle = on ? '#081200' : '#f0ffd6';
      c.textBaseline = 'middle';
      c.letterSpacing = cs.letterSpacing;
      c.translate(br.x + parseFloat(cs.paddingLeft) + (parseFloat(ls.marginLeft) || 0), br.y + br.h * 0.5);
      const m = new DOMMatrix(ls.transform);
      c.transform(m.a, m.b, m.c, m.d, 0, 0);
      c.fillText(label.textContent, 0, 0);
      c.restore();
    }

    // the A prompt, and the version in the corner
    const pc = layers.prompt.getContext('2d', options);
    const ball = prompt.querySelector('span');
    const pr = rect(prompt);
    const ar = rect(ball);
    const ps = getComputedStyle(prompt);
    pc.save();
    pc.beginPath();
    pc.arc(ar.x + ar.w / 2, ar.y + ar.h / 2, ar.w * 0.49, 0, Math.PI * 2);
    const g = pc.createRadialGradient(ar.x + ar.w * 0.5, ar.y + ar.h * 0.5, ar.w * 0.1, ar.x + ar.w * 0.5, ar.y + ar.h * 0.5, ar.w * 0.5);
    g.addColorStop(0, '#001600');
    g.addColorStop(0.72, '#134400');
    g.addColorStop(1, '#dfff62');
    pc.fillStyle = g;
    pc.shadowColor = '#baff00';
    pc.shadowBlur = ar.w * 0.13;
    pc.fill();
    pc.strokeStyle = '#f1ffad';
    pc.lineWidth = 1.2;
    pc.stroke();
    pc.shadowBlur = 0;
    pc.fillStyle = '#f2ffd5';
    pc.font = getComputedStyle(ball).font;
    pc.textAlign = 'center';
    pc.textBaseline = 'middle';
    pc.fillText('A', ar.x + ar.w * 0.5, ar.y + ar.h * 0.5);
    pc.textAlign = 'left';
    pc.font = `${ps.fontWeight} ${ps.fontSize} ${ps.fontFamily}`;
    pc.letterSpacing = ps.letterSpacing;
    pc.fillText('SELECT', ar.x + ar.w + parseFloat(ps.gap), pr.y + pr.h * 0.5);
    if (version && version.textContent) {
      const vr = rect(version);
      const vs = getComputedStyle(version);
      pc.globalAlpha = parseFloat(vs.opacity) || 1;
      pc.fillStyle = vs.color;
      pc.font = vs.font;
      pc.letterSpacing = vs.letterSpacing;
      pc.fillText(version.textContent.toUpperCase(), vr.x, vr.y + vr.h * 0.5);
    }
    pc.restore();
  }

  // Draws the home screen as the camera sees it at `p` (0..1) of the way out
  // (or, with `back`, of the way home) onto a canvas of w by h.
  function paint(ctx, p, back, w, h) {
    if (!layers.core) return;
    let scale;
    let alpha;
    let menuX;
    let menuAlpha;
    let gridAlpha;
    let promptAlpha;
    let coreX = 0;
    if (!back) {
      scale = 1 + Math.pow(Math.min(1, p / 0.43), 1.55) * 4;
      alpha = 1 - smooth(0.19, 0.43, p);
      menuX = frame.w * 0.24 * smooth(0.09, 0.34, p);
      menuAlpha = gridAlpha = 1;
      promptAlpha = 1 - smooth(0.08, 0.2, p);
      coreX = -frame.w * 0.02 * easeOut(p / 0.4);
    } else {
      scale = 1 + 4.5 * Math.pow(1 - smooth(0.55, 0.99, p), 1.5);
      alpha = smooth(0.48, 0.63, p);
      menuX = frame.w * 0.12 * (1 - smooth(0.6, 0.76, p));
      menuAlpha = smooth(0.67, 0.77, p);
      gridAlpha = smooth(0.53, 0.92, p);
      promptAlpha = smooth(0.85, 0.98, p);
    }
    if (alpha <= 0) return;
    const px = frame.x + frame.w * 0.53;
    const py = frame.y + frame.h * 0.43;
    ctx.save();
    ctx.scale(w / width, h / height);
    ctx.translate(px, py);
    ctx.scale(scale, scale);
    ctx.translate(-px, -py);
    for (const [key, a, x] of [['environment', gridAlpha, 0], ['core', 1, coreX], ['menu', menuAlpha, menuX], ['prompt', promptAlpha, 0]]) {
      ctx.globalAlpha = alpha * a;
      ctx.drawImage(layers[key], x, 0);
    }
    ctx.restore();
  }

  return { bake, paint };
}
