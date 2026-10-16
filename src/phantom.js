// Synthetic dental CBCT for the demo, screenshots and tests: a lower jaw with teeth, a nerve
// canal on each side and a matching CS 3D Imaging-style analysis. Shapes are simplified.
import { volumeStats } from './dicom.js';

const FOV = [80, 80, 50]; // mm
const CREST = 26; // alveolar crest height (mm)

function hash(i) {
  i = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  i ^= i >>> 13;
  i = Math.imul(i, 0xc2b2ae35);
  return ((i ^ (i >>> 16)) >>> 0) / 4294967296;
}

// Smooth value noise on a unit lattice (trilinear with a smoothstep fade).
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const v = (i, j, k) => hash(((xi + i) * 73856093) ^ ((yi + j) * 19349663) ^ ((zi + k) * 83492791));
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(lerp(v(0, 0, 0), v(1, 0, 0), ux), lerp(v(0, 1, 0), v(1, 1, 0), ux), uy),
    lerp(lerp(v(0, 0, 1), v(1, 0, 1), ux), lerp(v(0, 1, 1), v(1, 1, 1), ux), uy), uz);
}

// voxelsPerMm 4 gives the 0.25 mm demo; tests use a coarse 1 mm grid.
export function makePhantom({ voxelsPerMm = 4 } = {}) {
  const vox = 1 / voxelsPerMm;
  const [nx, ny, nz] = FOV.map((v) => Math.round(v * voxelsPerMm));
  const nxy = nx * ny;

  // Arch centre line (mm): a parabola, anterior at the front of the volume.
  const archX = (u) => 40 + u;
  const archY = (u) => 15 + 0.027 * u * u;
  const samples = 480;
  const ax = new Float32Array(samples), ay = new Float32Array(samples), as = new Float32Array(samples);
  const anx = new Float32Array(samples), any = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const u = -31 + (62 * i) / (samples - 1);
    ax[i] = archX(u);
    ay[i] = archY(u);
    if (i) as[i] = as[i - 1] + Math.hypot(ax[i] - ax[i - 1], ay[i] - ay[i - 1]);
    const tx = 1, ty = 0.054 * u, tl = Math.hypot(tx, ty);
    anx[i] = ty / tl; // buccal normal: away from the inside of the U
    any[i] = -tx / tl;
  }
  const L = as[samples - 1];
  const at = (s) => {
    let i = 0;
    while (i < samples - 2 && as[i + 1] < s) i++;
    const f = (s - as[i]) / (as[i + 1] - as[i] || 1);
    return [ax[i] + (ax[i + 1] - ax[i]) * f, ay[i] + (ay[i + 1] - ay[i]) * f, anx[i], any[i]];
  };

  // Teeth along the arch; one missing, one with a metal crown.
  const teeth = [];
  for (let k = 0; k < 14; k++) {
    if (k === 10) continue;
    const s = L * (0.07 + (0.86 * k) / 13);
    const mid = Math.abs(s - L / 2);
    const kind = mid < 9 ? 'incisor' : mid < 14 ? 'canine' : mid < 26 ? 'premolar' : 'molar';
    const spec = {
      incisor: { r: 2.5, root: 12.5, crown: 9 },
      canine: { r: 3.0, root: 16, crown: 9.5 },
      premolar: { r: 3.3, root: 14, crown: 8 },
      molar: { r: 4.6, root: 12.5, crown: 7 },
    }[kind];
    const [x, y] = at(s);
    teeth.push({ x, y, ...spec, metal: k === 1 });
  }

  // Nerve canals run inside the bone from the back of the jaw to the premolar region.
  const canalEnd = L * 0.27;
  const canalZ = (t) => 11.5 + 4 * (1 - t) * (1 - t); // t: 0 at the back, 1 at the front
  const canals = [0, 1].map((side) => {
    const points = [];
    for (let k = 0; k <= 9; k++) {
      const t = k / 9;
      const s = side ? L - t * canalEnd : t * canalEnd;
      const [x, y] = at(s);
      points.push([x / vox - 0.5, y / vox - 0.5, canalZ(t) / vox - 0.5]);
    }
    return points;
  });

  // Per-column lookups (distance to the arch, arc position, nearest tooth, canal height).
  const dMap = new Float32Array(nxy), sMap = new Float32Array(nxy);
  const toothIdx = new Int8Array(nxy).fill(-1), toothDist = new Float32Array(nxy);
  const canalMap = new Float32Array(nxy).fill(NaN);
  // Jaw shape per column: taller at the chin, wider at the molars, curved lower border.
  const bottomMap = new Float32Array(nxy), halfWMap = new Float32Array(nxy);
  for (let y = 0; y < ny; y++) {
    const py = (y + 0.5) * vox;
    for (let x = 0; x < nx; x++) {
      const px = (x + 0.5) * vox;
      const p = y * nx + x;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < samples; i += 2) {
        const d = (ax[i] - px) ** 2 + (ay[i] - py) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      dMap[p] = (px - ax[best]) * anx[best] + (py - ay[best]) * any[best];
      sMap[p] = as[best];
      let tb = -1, td = Infinity;
      teeth.forEach((tooth, i) => {
        const d = Math.hypot(px - tooth.x, py - tooth.y);
        if (d < td) { td = d; tb = i; }
      });
      if (td < 6) { toothIdx[p] = tb; toothDist[p] = td; }
      const s = sMap[p];
      const t = s < canalEnd ? s / canalEnd : s > L - canalEnd ? (L - s) / canalEnd : -1;
      if (t >= 0 && Math.abs(dMap[p]) < 3) canalMap[p] = canalZ(t);
      const front = Math.cos(Math.PI * (s / L - 0.5));
      bottomMap[p] = 9.5 - 4 * front;
      halfWMap[p] = 6.4 - 1.4 * front;
    }
  }

  const data = new Uint16Array(nxy * nz);
  const store = (hu) => Math.max(0, Math.min(65535, Math.round(hu + 1000)));
  const fovR = 39.5;
  for (let z = 0; z < nz; z++) {
    const pz = (z + 0.5) * vox;
    for (let y = 0; y < ny; y++) {
      const py = (y + 0.5) * vox;
      for (let x = 0; x < nx; x++) {
        const px = (x + 0.5) * vox;
        const p = y * nx + x;
        const idx = z * nxy + p;
        if ((px - 40) ** 2 + (py - 40) ** 2 > fovR * fovR) continue; // outside the scanned cylinder
        const noise = (hash(idx) - 0.5) * 260; // CBCT-like quantum noise
        const d = dMap[p];
        let hu = -960;

        // Soft tissue: a smooth envelope around the jaw plus the floor of the mouth.
        const sd = d / 12, sz2 = (pz - 17) / 21;
        const envelope = Math.sqrt(sd * sd + sz2 * sz2);
        const fd = (d + 9) / 10, fz = (pz - 11) / 11;
        const floor = Math.sqrt(fd * fd + fz * fz); // floor of the mouth, lingual to the jaw
        const tissue = Math.min(envelope, floor);
        if (tissue < 1) hu = 40;
        else if (tissue < 1.08) hu = -960 + 1000 * (1.08 - tissue) / 0.08;

        // Mandible: elliptical cross-section with a cortical shell and trabecular core.
        const bottom = bottomMap[p];
        const ez = (pz - (CREST + bottom) / 2) / ((CREST - bottom) / 2), ed = d / halfWMap[p];
        const rho = Math.sqrt(ed * ed + ez * ez);
        if (rho <= 1.1) {
          let bone;
          if (rho > 0.82) bone = 1700;
          else {
            const n = 0.65 * noise3(px * 0.9, py * 0.9, pz * 0.9) + 0.35 * noise3(px * 2.2, py * 2.2, pz * 2.2);
            bone = 300 + 900 * n;
          }
          hu = rho > 0.96 ? hu + (bone - hu) * Math.min(1, (1.1 - rho) / 0.14) : bone; // soft outer edge
        }

        // Inferior alveolar canal with a thin bony wall.
        const cz = canalMap[p];
        if (cz === cz) {
          const r2c = d * d + (pz - cz) ** 2;
          if (r2c < 1.69) hu = 60;
          else if (r2c < 2.4 && rho < 1) hu = 1300;
        }

        // Teeth: tapered roots, rounded crowns, enamel cap and pulp.
        const ti = toothIdx[p];
        if (ti >= 0) {
          const tooth = teeth[ti];
          const r2 = toothDist[p];
          let radius = 0;
          if (pz >= CREST) {
            const f = (pz - CREST) / tooth.crown;
            if (f <= 1) radius = tooth.r * Math.sqrt(1 - f ** 4);
          } else if (pz > CREST - tooth.root) {
            radius = tooth.r * 0.72 * ((pz - (CREST - tooth.root)) / tooth.root) ** 0.55;
          }
          if (r2 < radius) {
            if (r2 < radius * 0.28 && pz > CREST - tooth.root + 2 && pz < CREST + tooth.crown * 0.45) hu = 120;
            else if (tooth.metal && pz > CREST + 1.5) hu = 9000;
            else if (pz > CREST + 1.2 && r2 > radius - 1.1) hu = 3300;
            else hu = 1950;
          } else if (pz < CREST && r2 < radius + 0.35) {
            hu = 150; // periodontal ligament space
          }
        }
        data[idx] = store(hu + noise);
      }
    }
  }

  const archPoints = [];
  for (let k = 0; k <= 8; k++) {
    const [x, y] = at(L * (0.03 + (0.94 * k) / 8));
    archPoints.push([x / vox - 0.5, y / vox - 0.5, 22 / vox]);
  }
  const stats = volumeStats(data, nx, ny, nz);
  const today = new Date();
  const p2 = (n) => String(n).padStart(2, '0');

  return {
    meta: {
      dims: [nx, ny, nz],
      spacing: [vox, vox, vox],
      slope: 1,
      intercept: -1000,
      window: { center: 1048, width: 4096 },
      percentiles: stats.percentiles,
      max: stats.max,
      demo: true,
      patientName: '',
      patientId: 'DEMO',
      birthDate: '',
      studyDate: `${p2(today.getDate())}/${p2(today.getMonth() + 1)}/${today.getFullYear()}`,
      model: 'Synthetic phantom',
      manufacturer: '',
      kvp: '',
      comments: '',
      analysis: {
        name: 'Demo',
        reference: '',
        lut: null,
        ortho: [nx / 2, Math.round(15 / vox), Math.round(22 / vox)],
        arches: [{ id: 'demo', type: 'MandibularArch', name: 'Demo arch', points: archPoints }],
        canals: canals.map((points) => ({ name: 'Nerve canal', radius: 1.3, color: [1, 0.5, 0], points })),
      },
    },
    data,
  };
}
