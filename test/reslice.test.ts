import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/reslice.ts';

// Volume whose value at (x, y, z) is x + 10*y + 100*z.
function rampVolume(nx = 8, ny = 6, nz = 5) {
  const data = new Uint16Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) data[z * nx * ny + y * nx + x] = x + 10 * y + 100 * z;
  return { data, nx, ny, nz, sx: 0.5, sy: 0.5, sz: 0.5 };
}

test('orthogonal planes are oriented superior-up', () => {
  const vol = rampVolume();
  const ax = R.axial(vol, 2);
  assert.equal(ax.data[0], 200);
  const cor = R.coronal(vol, 3);
  assert.equal(cor.w, 8);
  assert.equal(cor.data[0], 30 + 100 * 4); // top row is the last (most superior) slice
  const sag = R.sagittal(vol, 1);
  assert.equal(sag.data[2], 1 + 20 + 400);
});

test('arches are ordered right to left with buccal normals', () => {
  const u = [-20, -10, 0, 10, 20];
  const points = u.map((v) => [50 + v, 20 + 0.05 * v * v, 0]).reverse();
  const arch = R.buildArch(points);
  assert.ok(arch.x[0] < arch.x[arch.M - 1], 'starts on the patient right (low x)');
  const mid = arch.M >> 1;
  assert.ok(arch.ny[mid] < -0.99, 'normal at the apex points anterior (outside the U)');
  assert.ok(Math.abs(arch.M - 1 - Math.floor(arch.length)) <= 1);
});

test('panoramic and cross-section have the expected shape', () => {
  const vol = rampVolume(40, 40, 6);
  const arch = R.buildArch([[5, 30, 0], [20, 10, 0], [35, 30, 0]]);
  const pano = R.panoramic(vol, R.panoCurve(arch, 0), 1, 'avg');
  assert.equal(pano.w, arch.M);
  assert.equal(pano.h, 6);
  const cs = R.crossSection(vol, arch, 10, 0, 12, 1);
  assert.equal(cs.w % 2, 1);
  assert.equal(cs.index, 10);
  assert.ok(Math.abs(cs.cx - arch.x[10]) < 1e-6);
  assert.ok(Math.abs(cs.nx - arch.nx[10]) < 1e-6);
});

// Half circle of radius 40 voxels around (60, 60), open towards +y like a dental arch.
const halfCircle = () => R.buildArch(Array.from({ length: 13 }, (_, k) => {
  const a = Math.PI * (k / 12);
  return [60 - 40 * Math.cos(a), 60 - 40 * Math.sin(a), 0];
}));

test('the panoramic keeps its scale in mm when the curve is moved buccally or lingually', () => {
  const arch = halfCircle();
  const identity = R.panoCurve(arch, 0);
  assert.equal(identity.M, arch.M);
  assert.equal(identity.at[7], 7);
  // A parallel curve d voxels out is d × (how far the normal turns) longer: about dπ here.
  const turn = Math.acos(arch.nx[0] * arch.nx[arch.M - 1] + arch.ny[0] * arch.ny[arch.M - 1]);
  for (const offset of [-10, 10]) {
    const curve = R.panoCurve(arch, offset);
    assert.ok(Math.abs(curve.M - 1 - (arch.length + turn * offset)) < 1.5, `length at ${offset}`);
    for (let j = 1; j < curve.M - 1; j++) {
      const step = Math.hypot(curve.x[j] - curve.x[j - 1], curve.y[j] - curve.y[j - 1]);
      assert.ok(Math.abs(step - 1) < 0.01, `column ${j} at ${offset}: ${step}`);
    }
    for (const j of [0, 17, curve.M >> 1, curve.M - 1]) assert.ok(Math.abs(R.panoColumn(curve, curve.at[j]) - j) < 1e-3);
    const mid = curve.M >> 1;
    assert.ok(Math.abs(curve.at[mid] - arch.M / 2) < 1.5, 'the front stays over the front');
  }
  const vol = rampVolume(120, 120, 3);
  assert.equal(R.panoramic(vol, R.panoCurve(arch, 10), 1, 'avg').w, R.panoCurve(arch, 10).M);
});

test('cross-sections can sit between arch samples', () => {
  const arch = halfCircle();
  const vol = rampVolume(120, 120, 3);
  const cs = R.crossSection(vol, arch, 20.5, 0, 12, 1);
  assert.equal(cs.index, 20.5);
  assert.ok(Math.abs(cs.cx - (arch.x[20] + arch.x[21]) / 2) < 1e-3);
  assert.ok(Math.abs(Math.hypot(cs.nx, cs.ny) - 1) < 1e-9);
  assert.ok(Math.abs(cs.nx * cs.tx + cs.ny * cs.ty) < 1e-3, 'normal is perpendicular to the tangent');
});

test('columns averages across the slab', () => {
  const vol = rampVolume(10, 10, 1);
  const out = R.columns(vol, new Float32Array([4]), new Float32Array([4]), new Float32Array([1]), new Float32Array([0]), 3, 'avg');
  assert.equal(out[0], 44); // mean of x = 3, 4, 5 at y = 4
  const max = R.columns(vol, new Float32Array([4]), new Float32Array([4]), new Float32Array([1]), new Float32Array([0]), 3, 'mip');
  assert.equal(max[0], 45);
});

test('crossings interpolates where a polyline meets a plane', () => {
  const hits = R.crossings([[0, 0, 0], [0, 0, 10], [0, 4, 10]], (p) => p[2] - 2.5);
  assert.deepEqual(hits, [[0, 0, 2.5]]);
});

test('finds the dental arch automatically on the demo jaw', async () => {
  const { makePhantom } = await import('../src/phantom.ts');
  const { detectArch } = await import('../src/autoarch.ts');
  const { meta, data } = makePhantom({ voxelsPerMm: 2 });
  const [nx, ny, nz] = meta.dims;
  const vol = { data, nx, ny, nz, sx: meta.spacing[0], sy: meta.spacing[1], sz: meta.spacing[2] };
  const found = detectArch(vol);
  assert.ok(found, 'arch found');
  const auto = R.buildArch(found.points);
  assert.ok(meta.analysis);
  const truth = R.buildArch(meta.analysis.arches[0].points);
  let sum = 0, n = 0;
  for (let i = 0; i < auto.M; i += 2) { sum += R.nearestOnArch(truth, auto.x[i], auto.y[i]).dist * vol.sx; n++; }
  assert.ok(sum / n < 1, `mean distance ${(sum / n).toFixed(2)} mm`);
  assert.ok(Math.abs(auto.length - truth.length) * vol.sx < 10, 'similar length');
});

test('reports no arch for a volume without teeth', async () => {
  const { detectArch } = await import('../src/autoarch.ts');
  const vol = { data: new Uint16Array(64 * 64 * 40).fill(1000), nx: 64, ny: 64, nz: 40, sx: 0.5, sy: 0.5, sz: 0.5 };
  assert.equal(detectArch(vol), null);
});
