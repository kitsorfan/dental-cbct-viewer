// WebGL2 ray-marched volume rendering (iso-surface, MIP, simulated X-ray).
// World axes match voxel axes: +x patient left, +y posterior, +z superior.

const VS = `#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform mat4 uInv;
uniform vec3 uHalf;
uniform vec3 uTexel;
uniform float uIso;
uniform int uMode;
uniform float uStep;
uniform float uGain;
in vec2 vNdc;
out vec4 frag;

vec3 tex(vec3 p) { return p / (2.0 * uHalf) + 0.5; }
float val(vec3 p) { return texture(uVol, tex(p)).r; }

vec3 grad(vec3 tc) {
  vec3 d = uTexel * 1.5;
  return vec3(
    texture(uVol, tc + vec3(d.x, 0, 0)).r - texture(uVol, tc - vec3(d.x, 0, 0)).r,
    texture(uVol, tc + vec3(0, d.y, 0)).r - texture(uVol, tc - vec3(0, d.y, 0)).r,
    texture(uVol, tc + vec3(0, 0, d.z)).r - texture(uVol, tc - vec3(0, 0, d.z)).r);
}

void main() {
  vec3 bg = mix(vec3(0.035, 0.04, 0.05), vec3(0.11, 0.12, 0.14), vNdc.y * 0.5 + 0.5);
  vec4 a = uInv * vec4(vNdc, -1.0, 1.0); a /= a.w;
  vec4 b = uInv * vec4(vNdc, 1.0, 1.0); b /= b.w;
  vec3 ro = a.xyz, rd = normalize(b.xyz - a.xyz);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-uHalf - ro) * inv, t1 = (uHalf - ro) * inv;
  vec3 tmn = min(t0, t1), tmx = max(t0, t1);
  float tn = max(max(tmn.x, tmn.y), tmn.z), tf = min(min(tmx.x, tmx.y), tmx.z);
  if (tf <= max(tn, 0.0)) { frag = vec4(bg, 1.0); return; }
  tn = max(tn, 0.0);
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float t = tn + jitter * uStep;

  if (uMode == 0) {
    bool hit = false;
    for (int i = 0; i < 4096; i++) {
      if (t > tf) break;
      if (val(ro + rd * t) >= uIso) {
        float lo = t - uStep, hi = t;
        for (int k = 0; k < 6; k++) {
          float mid = 0.5 * (lo + hi);
          if (val(ro + rd * mid) >= uIso) hi = mid; else lo = mid;
        }
        t = hi;
        hit = true;
        break;
      }
      t += uStep;
    }
    if (!hit) { frag = vec4(bg, 1.0); return; }
    vec3 p = ro + rd * t;
    vec3 n = -normalize(grad(tex(p)) + 1e-6);
    if (dot(n, rd) > 0.0) n = -n;
    float inside = val(p + rd * uStep * 2.0);
    float e = smoothstep(uIso + 0.10, uIso + 0.32, inside);
    vec3 base = mix(vec3(0.84, 0.77, 0.64), vec3(0.98, 0.97, 0.94), e);
    vec3 L = normalize(-rd + vec3(0.0, 0.0, 0.35));
    float diff = max(dot(n, L), 0.0);
    float spec = pow(max(dot(n, normalize(L - rd)), 0.0), 48.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    vec3 col = base * (0.22 + 0.78 * diff) + 0.22 * spec + 0.06 * rim;
    frag = vec4(col, 1.0);
    return;
  }

  float mx = 0.0, acc = 0.0;
  for (int i = 0; i < 4096; i++) {
    if (t > tf) break;
    float v = val(ro + rd * t);
    mx = max(mx, v);
    acc += max(v - 0.08, 0.0) * uStep;
    t += uStep;
  }
  float g;
  if (uMode == 1) g = clamp((mx - uIso) / max(1.0 - uIso, 1e-3), 0.0, 1.0);
  else g = 1.0 - exp(-acc * uGain);
  frag = vec4(mix(bg, vec3(1.0), g), 1.0);
}`;

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function lookAt(eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1];
}

function multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

function invert(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}

export class VolumeView {
  constructor(el, hooks) {
    this.el = el;
    this.hooks = hooks;
    this.wrap = el.querySelector('.canvas-wrap');
    this.canvas = this.wrap.querySelector('canvas');
    this.gl = this.canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    this.mode = 0;
    this.iso = 0.4;
    this.gain = 6;
    this.reset();
    this.ready = false;
    this.pending = 0;
    if (!this.gl) {
      this.failed = 'webgl';
      return;
    }
    this.init();
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.bind();
  }

  reset() {
    this.yaw = 0;
    this.pitch = 0.12;
    this.dist = 2.1;
  }

  init() {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.u = {};
    for (const name of ['uVol', 'uInv', 'uHalf', 'uTexel', 'uIso', 'uMode', 'uStep', 'uGain']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    this.vao = gl.createVertexArray();
  }

  // Downsample to <= ~300 voxels per axis and quantise to 8 bits over [lo, hi] stored values.
  setVolume(vol, lo, hi) {
    if (!this.gl) return;
    const { nx, ny, nz, data } = vol;
    const f = Math.max(1, Math.ceil(Math.max(nx, ny, nz) / 300));
    const dx = Math.floor(nx / f), dy = Math.floor(ny / f), dz = Math.floor(nz / f);
    const out = new Uint8Array(dx * dy * dz);
    const scale = 255 / (hi - lo);
    const norm = 1 / (f * f * f);
    const nxy = nx * ny;
    let o = 0;
    for (let z = 0; z < dz; z++) {
      for (let y = 0; y < dy; y++) {
        for (let x = 0; x < dx; x++) {
          let s = 0;
          for (let k = 0; k < f; k++) {
            const zb = (z * f + k) * nxy;
            for (let j = 0; j < f; j++) {
              let p = zb + (y * f + j) * nx + x * f;
              for (let i = 0; i < f; i++) s += data[p++];
            }
          }
          const v = (s * norm - lo) * scale;
          out[o++] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, dx, dy, dz, 0, gl.RED, gl.UNSIGNED_BYTE, out);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
      gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    }
    const phys = [dx * vol.sx * f, dy * vol.sy * f, dz * vol.sz * f];
    const m = Math.max(...phys);
    this.half = phys.map((p) => p / m / 2);
    this.texel = [1 / dx, 1 / dy, 1 / dz];
    this.stepWorld = Math.min(...this.half.map((h, i) => (2 * h) / [dx, dy, dz][i]));
    this.ready = true;
    this.render();
  }

  // Render at an exact pixel size into a new 2D canvas (for exports), then restore.
  snapshot(width, height) {
    if (!this.ready) return null;
    const c = this.canvas;
    const [w0, h0] = [c.width, c.height];
    c.width = Math.round(width);
    c.height = Math.round(height);
    this.draw(false);
    const out = document.createElement('canvas');
    out.width = c.width;
    out.height = c.height;
    out.getContext('2d').drawImage(c, 0, 0);
    c.width = w0;
    c.height = h0;
    this.draw(false);
    return out;
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.render();
  }

  render(fast = false) {
    if (!this.ready) return;
    cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => this.draw(fast));
    if (fast) {
      clearTimeout(this.settle);
      this.settle = setTimeout(() => this.render(false), 180);
    }
  }

  draw(fast) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    const cp = Math.cos(this.pitch);
    const eye = [this.dist * cp * Math.sin(this.yaw), -this.dist * cp * Math.cos(this.yaw), this.dist * Math.sin(this.pitch)];
    const view = lookAt(eye, [0, 0, 0], [0, 0, 1]);
    const proj = perspective((30 * Math.PI) / 180, w / h, 0.1, 10);
    gl.uniformMatrix4fv(this.u.uInv, false, invert(multiply(proj, view)));
    gl.uniform3fv(this.u.uHalf, this.half);
    gl.uniform3fv(this.u.uTexel, this.texel);
    gl.uniform1f(this.u.uIso, this.iso);
    gl.uniform1i(this.u.uMode, this.mode);
    gl.uniform1f(this.u.uStep, this.stepWorld * (fast ? 1.6 : 0.6));
    gl.uniform1f(this.u.uGain, this.gain);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.texture);
    gl.uniform1i(this.u.uVol, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  bind() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, button: e.button };
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.button === 2) {
        this.dist = Math.min(6, Math.max(0.8, this.dist * Math.exp(dy * 0.01)));
      } else {
        this.yaw -= dx * 0.01;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.01));
      }
      this.render(true);
    });
    const end = () => { drag = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.min(6, Math.max(0.8, this.dist * Math.exp(Math.sign(e.deltaY) * 0.1)));
      this.render(true);
    }, { passive: false });
    c.addEventListener('dblclick', (e) => this.hooks.dblclick(this, e));
  }
}
