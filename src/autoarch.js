// Automatic dental arch for scans without an analysis file.
// 1. Find the axial slab that holds the teeth (the densest voxels in the volume).
// 2. Project dense voxels in that slab onto the axial plane: the arch shows up as a U.
// 3. Cast rays from inside the U towards the front and sides, take the density-weighted
//    distance along each ray, smooth, and return control points for buildArch().

function percentileOf(data, q, stride = 7) {
  const hist = new Uint32Array(65536);
  let n = 0;
  for (let i = 0; i < data.length; i += stride) { hist[data[i]]++; n++; }
  const target = q * n;
  let acc = 0;
  for (let v = 0; v < 65536; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 65535;
}

function smooth(values, radius) {
  const out = values.slice();
  for (let i = 0; i < values.length; i++) {
    const win = [];
    for (let k = -radius; k <= radius; k++) {
      const v = values[i + k];
      if (v !== undefined && !Number.isNaN(v)) win.push(v);
    }
    if (!win.length) continue;
    win.sort((a, b) => a - b);
    out[i] = win[win.length >> 1];
  }
  return out;
}

// Returns { points: [[x, y, z], ...] } in voxel coordinates, or null if no arch is found.
// `info` collects intermediate values for tests and diagnostics.
export function detectArch(vol, info = {}) {
  const { data, nx, ny, nz, sx } = vol;
  const nxy = nx * ny;

  // Teeth slab: slices with many voxels above the 99.6th percentile (enamel, dentin).
  const high = percentileOf(data, 0.996);
  const profile = new Float64Array(nz);
  for (let z = 0; z < nz; z++) {
    let c = 0;
    const base = z * nxy;
    for (let p = 0; p < nxy; p += 3) if (data[base + p] >= high) c++;
    profile[z] = c;
  }
  const peak = Math.max(...profile);
  info.high = high;
  info.peak = peak;
  if (peak < 20) return null;
  const sm = smooth(Array.from(profile), 3);
  let z0 = sm.indexOf(Math.max(...sm)), z1 = z0;
  while (z0 > 0 && sm[z0 - 1] > peak * 0.25) z0--;
  while (z1 < nz - 1 && sm[z1 + 1] > peak * 0.25) z1++;

  info.slab = [z0, z1];
  // Axial density map of teeth plus alveolar bone. The window reaches 12 mm beyond the
  // crowns so the curve follows the middle of the jaw (roots tilt away from the crowns).
  const mid = percentileOf(data, 0.975);
  const map = new Float32Array(nxy);
  const reach = Math.round(12 / (vol.sz || sx));
  const zA = Math.max(0, z0 - reach), zB = Math.min(nz - 1, z1 + reach);
  const zStep = Math.max(1, Math.round((zB - zA + 1) / 60));
  for (let z = zA; z <= zB; z += zStep) {
    const base = z * nxy;
    for (let p = 0; p < nxy; p++) if (data[base + p] >= mid) map[p] += data[base + p] >= high ? 3 : 1;
  }

  // Centre inside the U: density-weighted centroid, nudged towards the back.
  let wx = 0, wy = 0, w = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = map[y * nx + x];
      if (v) { wx += v * x; wy += v * y; w += v; }
    }
  }
  if (!w) return null;
  const cx = wx / w;
  const cy = wy / w + (10 / sx);
  info.mid = mid;
  info.centre = [cx, cy];

  // Rays: angle 0 points anterior (-y); negative angles go to the patient's right (-x).
  // Along each ray take the densest band (the arch), not the mean of everything crossed.
  const rMax = Math.ceil(Math.hypot(nx, ny));
  const band = Math.max(2, Math.round(6 / sx));
  const minMass = 4 * ((zB - zA) / zStep + 1);
  const angles = [];
  const radii = [];
  const prof = new Float32Array(rMax);
  for (let deg = -115; deg <= 115; deg += 2.5) {
    const a = (deg * Math.PI) / 180;
    const dx = Math.sin(a), dy = -Math.cos(a);
    prof.fill(0);
    let len = 0;
    for (let r = 4; r < rMax; r++) {
      const x = Math.round(cx + dx * r), y = Math.round(cy + dy * r);
      if (x < 0 || y < 0 || x >= nx || y >= ny) break;
      prof[r] = map[y * nx + x];
      len = r + 1;
    }
    let bestR = -1, bestMass = 0;
    let mass = 0;
    for (let r = 0; r < len; r++) {
      mass += prof[r] - (r - band >= 0 ? prof[r - band] : 0);
      if (mass > bestMass) { bestMass = mass; bestR = r - band / 2; }
    }
    let sum = 0, sumR = 0;
    if (bestR >= 0) {
      for (let r = Math.max(0, Math.round(bestR - band)); r < Math.min(len, bestR + band); r++) { sum += prof[r]; sumR += prof[r] * r; }
    }
    angles.push(a);
    radii.push(sum > minMass ? sumR / sum : NaN);
  }

  // Gaps between teeth or a missing tooth leave short holes: bridge them. Rays that jump
  // away from their neighbours (another structure) are dropped and bridged too.
  const bridge = (values, maxGap) => {
    const out = values.slice();
    for (let i = 0; i < out.length;) {
      if (!Number.isNaN(out[i])) { i++; continue; }
      let j = i;
      while (j < out.length && Number.isNaN(out[j])) j++;
      if (i > 0 && j < out.length && j - i <= maxGap) {
        for (let k = i; k < j; k++) out[k] = out[i - 1] + ((out[j] - out[i - 1]) * (k - i + 1)) / (j - i + 1);
      }
      i = j;
    }
    return out;
  };
  let filled = bridge(radii, 6);
  const median = smooth(filled, 4);
  filled = bridge(filled.map((v, i) => (Math.abs(v - median[i]) > Math.max(3 / sx, 0.12 * median[i]) ? NaN : v)), 6);

  // Keep the longest run of valid rays, then smooth the radius profile.
  let best = [0, -1], start = -1;
  for (let i = 0; i <= filled.length; i++) {
    const ok = i < filled.length && !Number.isNaN(filled[i]);
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      if (i - 1 - start > best[1] - best[0]) best = [start, i - 1];
      start = -1;
    }
  }
  info.radii = filled.map((v) => (Number.isNaN(v) ? null : Math.round(v)));
  info.run = best;
  if (best[1] - best[0] < 20) return null; // under ~50 degrees of arch
  const r = smooth(filled.slice(best[0], best[1] + 1), 3);
  const a = angles.slice(best[0], best[1] + 1);

  const zMid = (z0 + z1) / 2;
  const points = [];
  for (let i = 0; i < r.length; i += 3) {
    points.push([cx + Math.sin(a[i]) * r[i], cy - Math.cos(a[i]) * r[i], zMid]);
  }
  const last = r.length - 1;
  if ((last % 3) !== 0) points.push([cx + Math.sin(a[last]) * r[last], cy - Math.cos(a[last]) * r[last], zMid]);

  // Sanity: a dental arch is roughly 60-200 mm long.
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  length *= sx;
  info.length = length;
  if (length < 40 || length > 220) return null;
  return { points, slab: [z0, z1] };
}
