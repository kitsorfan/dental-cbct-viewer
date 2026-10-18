// Volume reslicing: orthogonal planes, curved (panoramic) and cross-sectional reformats.
// Voxel coordinates: x = column (patient left +), y = row (posterior +), z = slice (superior +).
// Curved reformats assume square in-plane pixels (true for CBCT).

// Stored voxel values with their spacing in mm.
export interface Volume {
  data: Uint16Array;
  nx: number;
  ny: number;
  nz: number;
  sx: number;
  sy: number;
  sz: number;
}

// A 2D image cut from the volume: w × h pixels of sx × sy mm.
export interface Plane {
  w: number;
  h: number;
  sx: number;
  sy: number;
  data: Uint16Array;
}

// A cross-section also knows where it sits on the arch: at arch sample `index` (fractional),
// centred on (cx, cy), with the arch's unit tangent and buccal normal there.
export interface CrossPlane extends Plane {
  half: number;
  cx: number;
  cy: number;
  index: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
}

// The panoramic's curve: the arch moved along its normals and resampled at 1-voxel steps.
// Column j sits over arch sample at[j] (fractional).
export interface PanoCurve {
  M: number;
  x: Float32Array;
  y: Float32Array;
  nx: Float32Array;
  ny: Float32Array;
  at: Float32Array;
}

// An arch resampled at 1-voxel steps: positions, unit tangents and buccal normals.
export interface Arch {
  M: number;
  x: Float32Array;
  y: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  nx: Float32Array;
  ny: Float32Array;
  z: number;
  length: number;
}

export type Point = number[];
export type PanoMode = 'avg' | 'mip';

export function axial(vol: Volume, z: number): Plane {
  const { nx, ny } = vol;
  const nxy = nx * ny;
  return { w: nx, h: ny, sx: vol.sx, sy: vol.sy, data: vol.data.subarray(z * nxy, (z + 1) * nxy) };
}

export function coronal(vol: Volume, y: number): Plane {
  const { nx, ny, nz, data } = vol;
  const nxy = nx * ny;
  const out = new Uint16Array(nx * nz);
  for (let z = 0; z < nz; z++) {
    const src = z * nxy + y * nx;
    out.set(data.subarray(src, src + nx), (nz - 1 - z) * nx);
  }
  return { w: nx, h: nz, sx: vol.sx, sy: vol.sz, data: out };
}

export function sagittal(vol: Volume, x: number): Plane {
  const { nx, ny, nz, data } = vol;
  const nxy = nx * ny;
  const out = new Uint16Array(ny * nz);
  for (let z = 0; z < nz; z++) {
    const row = (nz - 1 - z) * ny;
    let src = z * nxy + x;
    for (let y = 0; y < ny; y++, src += nx) out[row + y] = data[src];
  }
  return { w: ny, h: nz, sx: vol.sy, sy: vol.sz, data: out };
}

// Sample every z at a set of (x, y) column positions, optionally averaging or taking the max
// over `thick` samples spread along (dx, dy). Output rows run superior -> inferior.
export function columns(vol: Volume, xs: Float32Array, ys: Float32Array, dx: Float32Array, dy: Float32Array, thick: number, mode: PanoMode) {
  const { nx, ny, nz, data } = vol;
  const nxy = nx * ny;
  const W = xs.length;
  const T = Math.max(1, Math.round(thick));
  const K = W * T;
  const idx = new Int32Array(K);
  const fx = new Float32Array(K);
  const fy = new Float32Array(K);
  for (let i = 0; i < W; i++) {
    for (let t = 0; t < T; t++) {
      const d = t - (T - 1) / 2;
      const x = xs[i] + d * dx[i];
      const y = ys[i] + d * dy[i];
      const k = i * T + t;
      if (x < 0 || y < 0 || x >= nx - 1 || y >= ny - 1) { idx[k] = -1; continue; }
      const x0 = Math.floor(x), y0 = Math.floor(y);
      idx[k] = y0 * nx + x0;
      fx[k] = x - x0;
      fy[k] = y - y0;
    }
  }
  const out = new Uint16Array(W * nz);
  const useMax = mode === 'mip';
  for (let z = 0; z < nz; z++) {
    const base = z * nxy;
    const row = (nz - 1 - z) * W;
    for (let i = 0; i < W; i++) {
      let acc = 0, cnt = 0;
      for (let t = 0, k = i * T; t < T; t++, k++) {
        const j = idx[k];
        if (j < 0) continue;
        const a = fx[k], b = fy[k], p = base + j;
        const v = (data[p] * (1 - a) + data[p + 1] * a) * (1 - b) +
                  (data[p + nx] * (1 - a) + data[p + nx + 1] * a) * b;
        if (useMax) { if (v > acc) acc = v; } else acc += v;
        cnt++;
      }
      out[row + i] = cnt ? (useMax ? acc : acc / cnt) + 0.5 : 0;
    }
  }
  return out;
}

// Centripetal Catmull-Rom through control points ([x, y, z] arrays).
export function spline(points: Point[], perSegment = 24): Point[] {
  const n = points.length;
  if (n < 2) return points.slice();
  const P = (i: number) => {
    if (i < 0) return points[0].map((v, k) => 2 * v - points[1][k]);
    if (i >= n) return points[n - 1].map((v, k) => 2 * v - points[n - 2][k]);
    return points[i];
  };
  const dist = (a: Point, b: Point) => Math.max(1e-4, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) ** 0.5);
  const lerp = (a: Point, b: Point, ta: number, tb: number, t: number) => a.map((v, k) => ((tb - t) * v + (t - ta) * b[k]) / (tb - ta));
  const out: Point[] = [];
  for (let s = 0; s < n - 1; s++) {
    const p0 = P(s - 1), p1 = P(s), p2 = P(s + 1), p3 = P(s + 2);
    const t0 = 0, t1 = t0 + dist(p0, p1), t2 = t1 + dist(p1, p2), t3 = t2 + dist(p2, p3);
    for (let k = 0; k < perSegment; k++) {
      const t = t1 + (t2 - t1) * (k / perSegment);
      const a1 = lerp(p0, p1, t0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
      out.push(lerp(b1, b2, t1, t2, t));
    }
  }
  out.push(points[n - 1].slice());
  return out;
}

// Resample an arch at 1-voxel arc-length steps, ordered patient-right -> patient-left,
// with unit tangents and buccal (outward) normals in the axial plane.
export function buildArch(controlPoints: Point[]): Arch {
  let pts = controlPoints.map((p) => [p[0], p[1], p[2] ?? 0]);
  if (pts[0][0] > pts[pts.length - 1][0]) pts = pts.reverse();
  const flat = pts.map((p) => [p[0], p[1], 0]);
  const dense = spline(flat, 64);

  const cum = [0];
  for (let i = 1; i < dense.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const M = Math.max(2, Math.floor(total) + 1);
  const x = new Float32Array(M), y = new Float32Array(M);
  let j = 0;
  for (let i = 0; i < M; i++) {
    const s = Math.min(i, total);
    while (j < dense.length - 2 && cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const f = (s - cum[j]) / seg;
    x[i] = dense[j][0] + (dense[j + 1][0] - dense[j][0]) * f;
    y[i] = dense[j][1] + (dense[j + 1][1] - dense[j][1]) * f;
  }

  const tx = new Float32Array(M), ty = new Float32Array(M);
  const nx = new Float32Array(M), ny = new Float32Array(M);
  const W = 4;
  for (let i = 0; i < M; i++) {
    const a = Math.max(0, i - W), b = Math.min(M - 1, i + W);
    let ux = x[b] - x[a], uy = y[b] - y[a];
    const len = Math.hypot(ux, uy) || 1;
    ux /= len; uy /= len;
    tx[i] = ux; ty[i] = uy;
    nx[i] = uy; ny[i] = -ux;
  }

  let cx = 0, cy = 0;
  for (let i = 0; i < M; i++) { cx += x[i]; cy += y[i]; }
  cx /= M; cy /= M;
  let side = 0;
  for (let i = 0; i < M; i++) side += nx[i] * (x[i] - cx) + ny[i] * (y[i] - cy);
  if (side < 0) for (let i = 0; i < M; i++) { nx[i] = -nx[i]; ny[i] = -ny[i]; }

  const z = pts.reduce((s, p) => s + p[2], 0) / pts.length;
  return { M, x, y, tx, ty, nx, ny, z, length: total };
}

export function nearestOnArch(arch: Arch, px: number, py: number) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < arch.M; i++) {
    const d = (arch.x[i] - px) ** 2 + (arch.y[i] - py) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, dist: Math.sqrt(bestD) };
}

// Position, unit tangent and buccal normal at fractional arch sample s.
export function archAt(arch: Arch, s: number) {
  const i = Math.max(0, Math.min(arch.M - 1, s));
  const i0 = Math.min(Math.floor(i), arch.M - 2), f = i - i0;
  const lerp = (v: Float32Array) => v[i0] + (v[i0 + 1] - v[i0]) * f;
  const tx = lerp(arch.tx), ty = lerp(arch.ty), nx = lerp(arch.nx), ny = lerp(arch.ny);
  const t = Math.hypot(tx, ty) || 1, n = Math.hypot(nx, ny) || 1;
  return { x: lerp(arch.x), y: lerp(arch.y), tx: tx / t, ty: ty / t, nx: nx / n, ny: ny / n };
}

// Moved buccally the arch gets longer and moved lingually shorter, so the moved curve is
// resampled: its columns stay 1 voxel apart and the panoramic keeps its scale in mm.
export function panoCurve(arch: Arch, offsetVox: number): PanoCurve {
  const { M } = arch;
  if (!offsetVox) return { M, x: arch.x, y: arch.y, nx: arch.nx, ny: arch.ny, at: Float32Array.from({ length: M }, (_, i) => i) };
  const ox = new Float64Array(M), oy = new Float64Array(M), cum = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    ox[i] = arch.x[i] + offsetVox * arch.nx[i];
    oy[i] = arch.y[i] + offsetVox * arch.ny[i];
    if (i) cum[i] = cum[i - 1] + Math.hypot(ox[i] - ox[i - 1], oy[i] - oy[i - 1]);
  }
  const total = cum[M - 1];
  const N = Math.max(2, Math.floor(total) + 1);
  const x = new Float32Array(N), y = new Float32Array(N), nx = new Float32Array(N), ny = new Float32Array(N);
  const at = new Float32Array(N);
  let i = 0;
  for (let j = 0; j < N; j++) {
    const s = Math.min(j, total);
    while (i < M - 2 && cum[i + 1] < s) i++;
    const seg = cum[i + 1] - cum[i];
    const f = seg > 0 ? Math.min(1, (s - cum[i]) / seg) : 0;
    at[j] = i + f;
    x[j] = ox[i] + (ox[i + 1] - ox[i]) * f;
    y[j] = oy[i] + (oy[i + 1] - oy[i]) * f;
    const p = archAt(arch, at[j]);
    nx[j] = p.nx;
    ny[j] = p.ny;
  }
  return { M: N, x, y, nx, ny, at };
}

// The (fractional) panoramic column over arch sample s.
export function panoColumn(curve: PanoCurve, s: number) {
  const { at, M } = curve;
  if (s <= at[0]) return 0;
  if (s >= at[M - 1]) return M - 1;
  let lo = 0, hi = M - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at[mid] <= s) lo = mid; else hi = mid;
  }
  const span = at[hi] - at[lo];
  return lo + (span > 0 ? (s - at[lo]) / span : 0);
}

export function panoramic(vol: Volume, curve: PanoCurve, thickVox: number, mode: PanoMode): Plane {
  return { w: curve.M, h: vol.nz, sx: vol.sx, sy: vol.sz, data: columns(vol, curve.x, curve.y, curve.nx, curve.ny, thickVox, mode) };
}

// Plane perpendicular to the arch at sample `index`, which may fall between samples so that
// sections can be exactly 1 mm apart; column 0 is buccal.
export function crossSection(vol: Volume, arch: Arch, index: number, offsetVox: number, widthVox: number, thickVox: number): CrossPlane {
  const W = Math.max(8, Math.round(widthVox) | 1);
  const half = (W - 1) / 2;
  const s = Math.max(0, Math.min(arch.M - 1, index));
  const { x, y, tx, ty, nx, ny } = archAt(arch, s);
  const cx = x + offsetVox * nx;
  const cy = y + offsetVox * ny;
  const xs = new Float32Array(W), ys = new Float32Array(W);
  const dx = new Float32Array(W).fill(tx);
  const dy = new Float32Array(W).fill(ty);
  for (let j = 0; j < W; j++) {
    const d = half - j;
    xs[j] = cx + d * nx;
    ys[j] = cy + d * ny;
  }
  return {
    w: W, h: vol.nz, sx: vol.sx, sy: vol.sz, half, cx, cy, index: s, tx, ty, nx, ny,
    data: columns(vol, xs, ys, dx, dy, thickVox, 'avg'),
  };
}

// Where a 3D polyline crosses the plane f(p) = 0; returns interpolated points.
export function crossings(poly: Point[], f: (p: Point) => number): Point[] {
  const hits: Point[] = [];
  let prev = f(poly[0]);
  for (let k = 1; k < poly.length; k++) {
    const cur = f(poly[k]);
    if ((prev <= 0 && cur > 0) || (prev > 0 && cur <= 0)) {
      const t = prev / (prev - cur);
      const a = poly[k - 1], b = poly[k];
      hits.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
    prev = cur;
  }
  return hits;
}
