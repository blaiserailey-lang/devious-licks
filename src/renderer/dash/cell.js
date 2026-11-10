// The green cell that hangs in the dark between two screens and then swells
// past the camera. It is painted here, once, when the window opens: a dark
// forest-green hollow inside a paler, slightly uneven skin, with faint wavy
// bands running across it.

// A closed outline that is nearly, but not quite, a circle.
function outline(c, radius, wobble, phase) {
  c.beginPath();
  for (let i = 0; i <= 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    const r = radius * (1 + wobble * (0.5 * Math.sin(a * 3 + phase) + 0.3 * Math.sin(a * 5 - phase * 1.7) + 0.2 * Math.sin(a * 9 + phase * 0.6)));
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i) c.lineTo(x, y);
    else c.moveTo(x, y);
  }
  c.closePath();
}

export function paintCell(size = 640) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  if (!c) return canvas;
  const R = size * 0.46;
  c.translate(size / 2, size / 2);

  // the skin: olive, see-through, a little brighter toward its edge
  c.save();
  outline(c, R, 0.022, 0.4);
  c.clip();
  const skin = c.createRadialGradient(0, 0, R * 0.55, 0, 0, R * 1.03);
  skin.addColorStop(0, '#2a5c0600');
  skin.addColorStop(0.55, '#3f6f10b0');
  skin.addColorStop(0.82, '#6f9330cc');
  skin.addColorStop(0.94, '#9cb04ec0');
  skin.addColorStop(1, '#b9c36a90');
  c.fillStyle = skin;
  c.fillRect(-size, -size, size * 2, size * 2);
  c.restore();

  // the hollow: dark in the middle, green toward the skin
  c.save();
  outline(c, R * 0.885, 0.014, 2.1);
  c.clip();
  const hollow = c.createRadialGradient(R * 0.06, R * 0.04, R * 0.08, 0, 0, R * 0.9);
  hollow.addColorStop(0, '#011000f4');
  hollow.addColorStop(0.38, '#041c00f0');
  hollow.addColorStop(0.7, '#124400e8');
  hollow.addColorStop(0.9, '#2f7305dc');
  hollow.addColorStop(1, '#4d8a12d0');
  c.fillStyle = hollow;
  c.fillRect(-size, -size, size * 2, size * 2);

  // the bands: thin wavy lines across the hollow, lost in the dark middle
  c.lineCap = 'round';
  for (let i = -15; i <= 15; i++) {
    const y0 = (i / 15) * R * 0.86;
    const half = Math.sqrt(Math.max(0, R * R * 0.78 - y0 * y0));
    if (half < R * 0.1) continue;
    const steps = 64;
    for (let k = 0; k < steps; k++) {
      const u0 = -1 + (2 * k) / steps;
      const u1 = -1 + (2 * (k + 1)) / steps;
      const at = (u) => [u * half, y0 + R * 0.012 * Math.sin(u * 9 + i * 1.3) + R * 0.02 * u * u * Math.sign(i || 1) + R * 0.008 * Math.sin(u * 23 + i)];
      const [x0, ya] = at(u0);
      const [x1, yb] = at(u1);
      const edge = Math.min(1, Math.hypot((x0 + x1) / 2, y0) / (R * 0.86));
      const alpha = 0.34 * Math.pow(edge, 2.6) * (i % 2 ? 0.7 : 1);
      if (alpha < 0.01) continue;
      c.strokeStyle = `rgba(118,190,34,${alpha.toFixed(3)})`;
      c.lineWidth = size / 420;
      c.beginPath();
      c.moveTo(x0, ya);
      c.lineTo(x1, yb);
      c.stroke();
    }
  }

  // folds: a few soft rings going back into the depth
  for (const [r, a, dx, dy] of [[0.72, 0.1, 0.02, 0.01], [0.56, 0.075, 0.035, 0.02], [0.4, 0.05, 0.05, 0.03]]) {
    c.save();
    c.translate(R * dx, R * dy);
    outline(c, R * r, 0.03, r * 9);
    c.strokeStyle = `rgba(70,140,14,${a})`;
    c.lineWidth = R * 0.05;
    c.filter = `blur(${Math.max(1, size / 200)}px)`;
    c.stroke();
    c.restore();
  }
  c.restore();

  // where the hollow meets the skin, and the skin's own edge
  c.save();
  outline(c, R * 0.885, 0.014, 2.1);
  c.strokeStyle = '#a7bd5c55';
  c.lineWidth = size / 170;
  c.stroke();
  outline(c, R * 0.992, 0.022, 0.4);
  c.strokeStyle = '#c9cf7a66';
  c.lineWidth = size / 260;
  c.stroke();
  c.restore();

  // uneven light on the skin, upper left and lower right
  c.save();
  outline(c, R, 0.022, 0.4);
  c.clip();
  c.globalCompositeOperation = 'lighter';
  for (const [x, y, r, color] of [[-0.55, -0.6, 0.75, '#dfe6a030'], [0.62, 0.5, 0.6, '#9fc04022'], [-0.1, -0.92, 0.4, '#e9efb028']]) {
    const light = c.createRadialGradient(R * x, R * y, 0, R * x, R * y, R * r);
    light.addColorStop(0, color);
    light.addColorStop(1, '#00000000');
    c.fillStyle = light;
    c.fillRect(-size, -size, size * 2, size * 2);
  }
  c.restore();
  return canvas;
}
