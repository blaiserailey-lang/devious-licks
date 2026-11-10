// The DL orb on the home screen: the orb picture drawn through a small shader
// that makes it wobble like liquid, and lean toward the menu item that was
// just chosen. Without WebGL the plain picture is shown instead.
import { still, awake, onAwakeChange } from './prefs.js';

const VERTEX = 'attribute vec2 a;varying vec2 v;void main(){v=a*.5+.5;gl_Position=vec4(a,0.,1.);}';
const FRAGMENT = `precision highp float;
varying vec2 v;
uniform sampler2D art;
uniform float t;
uniform vec2 pull;
void main(){
  vec2 uv=v;
  vec2 p=uv-vec2(.50,.49);
  float m=exp(-dot(p,p)*7.);
  float l=length(pull);
  vec2 d=pull/max(l,.00001);
  uv-=pull*(.027+.055*smoothstep(-.4,.4,dot(p,d)))*m;
  uv-=d*dot(p,d)*l*.08*m;
  uv.x+=.0045*sin(p.y*11.+t*.73)*m;
  uv.y+=.0035*sin(p.x*12.-t*.62)*m;
  uv=vec2(.5)+((uv-vec2(.5))/(1.+.005*sin(t*.6)));
  if(any(lessThan(uv,vec2(0.)))||any(greaterThan(uv,vec2(1.)))){gl_FragColor=vec4(0.);return;}
  gl_FragColor=texture2D(art,uv);
}`;

export function createOrb({ root, home, canvas, image }) {
  let gl;
  let timeLoc;
  let pullLoc;
  let ready = false;
  let raf = 0;
  let last = 0;
  let time = 0;
  const pull = { x: 0, y: 0, vx: 0, vy: 0 };

  const active = () => !root.dataset.transitioning && !home.hidden && awake() && !still();

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function paint() {
    if (!ready) return;
    gl.uniform1f(timeLoc, time);
    gl.uniform2f(pullLoc, pull.x, pull.y);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function resize() {
    if (!ready) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.min(1100, Math.round(r.width * ratio)));
    canvas.height = Math.max(1, Math.min(1100, Math.round(r.height * ratio)));
    gl.viewport(0, 0, canvas.width, canvas.height);
    paint();
  }

  // The lean springs back to rest.
  function spring(dt) {
    const steps = Math.ceil(dt * 120);
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      pull.vx += (-70 * pull.x - 7.5 * pull.vx) * h;
      pull.vy += (-70 * pull.y - 7.5 * pull.vy) * h;
      pull.x += pull.vx * h;
      pull.y += pull.vy * h;
    }
    const length = Math.hypot(pull.x, pull.y);
    if (length > 0.42) {
      pull.x *= 0.42 / length;
      pull.y *= 0.42 / length;
    }
  }

  function tick(now) {
    raf = 0;
    if (!active()) return;
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
    last = now;
    time += dt;
    spring(dt);
    paint();
    raf = requestAnimationFrame(tick);
  }

  function update() {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    if (!active()) {
      pull.x = pull.y = pull.vx = pull.vy = 0;
      paint();
    } else if (ready) raf = requestAnimationFrame(tick);
  }

  function init() {
    try {
      gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false });
      if (!gl) throw new Error('no WebGL');
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.bindAttribLocation(program, 0, 'a');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('the shader did not link');
      gl.useProgram(program);
      const corners = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.uniform1i(gl.getUniformLocation(program, 'art'), 0);
      timeLoc = gl.getUniformLocation(program, 't');
      pullLoc = gl.getUniformLocation(program, 'pull');
      ready = true;
      canvas.hidden = false;
      image.hidden = true;
      resize();
      update();
    } catch {
      ready = false;
      canvas.hidden = true;
      image.hidden = false;
    }
  }

  // The orb leans toward the menu item that was just chosen.
  function react(item) {
    if (!active()) return;
    const b = item.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const dx = b.left + b.width * 0.18 - c.left - c.width * 0.5;
    const dy = c.top + c.height * 0.5 - b.top - b.height * 0.5;
    const length = Math.max(1, Math.hypot(dx, dy));
    pull.vx = (dx / length) * 4;
    pull.vy = (dy / length) * 4;
  }

  new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['data-transitioning'] });
  new MutationObserver(update).observe(home, { attributes: true, attributeFilter: ['hidden'] });
  new ResizeObserver(resize).observe(canvas.parentElement);
  onAwakeChange(update);
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    ready = false;
    cancelAnimationFrame(raf);
    canvas.hidden = true;
    image.hidden = false;
  });
  canvas.addEventListener('webglcontextrestored', init);
  if (image.complete && image.naturalWidth) init();
  else image.addEventListener('load', init, { once: true });

  return { react, update };
}
