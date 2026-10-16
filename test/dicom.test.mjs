import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanEntries, loadSeries, DicomError } from '../src/dicom.js';
import { writeDicom, ctSlice, fileEntry } from './dicom-writer.mjs';

const slices = (zs, opts = {}) => zs.map((z, i) => fileEntry(
  writeDicom(ctSlice({ z, instance: i + 1, ...opts }), opts.write), `scan/Data/slice${i}.dcm`));

test('reads an explicit VR series and sorts slices by position', async () => {
  const series = await scanEntries(slices([2, 0, 1]));
  assert.equal(series.length, 1);
  assert.equal(series[0].count, 3);
  assert.equal(series[0].patientName, 'DOE JANE');
  assert.equal(series[0].studyDate, '12/10/2026');

  const { meta, data } = await loadSeries(series[0]);
  assert.deepEqual(meta.dims, [3, 4, 3]);
  assert.deepEqual(meta.spacing, [0.4, 0.5, 1]);
  assert.equal(meta.intercept, -1000);
  // Slice k holds k * 100 + pixel index after sorting by z.
  assert.deepEqual([data[0], data[12], data[24], data[25]], [0, 100, 200, 201]);
});

test('decodes UTF-8 names (ISO_IR 192)', async () => {
  const extra = [[0x00100010, 'PN', 'ΠΑΠΑΔΟΠΟΥΛΟΣ^ΓΙΩΡΓΟΣ']];
  const [s] = await scanEntries(slices([0, 1], { extra }));
  assert.equal(s.patientName, 'ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΙΩΡΓΟΣ');
});

test('reads implicit VR little endian', async () => {
  const [s] = await scanEntries(slices([0, 1], { write: { transfer: '1.2.840.10008.1.2' } }));
  const { meta, data } = await loadSeries(s);
  assert.deepEqual(meta.dims, [3, 4, 2]);
  assert.equal(data[12], 100);
});

test('shifts signed pixels and keeps Hounsfield values', async () => {
  const pixels = new Int16Array(12).map((_, i) => -1000 + i * 250);
  const [s] = await scanEntries(slices([0], { signed: true, pixels }));
  const { meta, data } = await loadSeries(s);
  for (let i = 0; i < 12; i++) assert.equal(data[i] * meta.slope + meta.intercept, pixels[i] - 1000);
});

test('skips undefined-length sequences before the pixel data', async () => {
  const extra = [[0x00091010, 'SQ', [[[0x00091011, 'LO', 'private'], [0x00091012, 'SQ', [[[0x00091013, 'LO', 'nested']]]]]]]];
  const [s] = await scanEntries(slices([0, 1], { extra }));
  const { data } = await loadSeries(s);
  assert.equal(data[13], 101);
});

test('reads headers larger than the first 64 KB', async () => {
  const extra = [[0x00091020, 'OB', new Uint8Array(100_000)]];
  const [s] = await scanEntries(slices([0, 1], { extra }));
  const { data } = await loadSeries(s);
  assert.equal(data[12], 100);
});

test('reads multi-frame images using per-frame positions', async () => {
  const rows = 2, cols = 2;
  const pixels = new Uint16Array([...Array(4).fill(30), ...Array(4).fill(10), ...Array(4).fill(20)]);
  const frame = (z) => [[0x00209113, 'SQ', [[[0x00200032, 'DS', `0\\0\\${z}`]]]]];
  const extra = [
    [0x00280008, 'IS', '3'],
    [0x00280030, 'DS', '0.3\\0.3'],
    [0x52009229, 'SQ', [[[0x00289110, 'SQ', [[[0x00180050, 'DS', '0.3']]]]]]],
    [0x52009230, 'SQ', [frame(0.6), frame(0), frame(0.3)]],
  ];
  const elements = ctSlice({ rows, cols, pixels, extra }).filter((e) => e[0] !== 0x00200032);
  const [s] = await scanEntries([fileEntry(writeDicom(elements), 'enhanced.dcm')]);
  assert.equal(s.count, 3);
  const { meta, data } = await loadSeries(s);
  assert.deepEqual(meta.dims, [2, 2, 3]);
  assert.ok(Math.abs(meta.spacing[2] - 0.3) < 1e-9);
  assert.deepEqual([data[0], data[4], data[8]], [10, 20, 30]);
});

test('finds DICOM files that have no extension', async () => {
  const entries = [0, 1].map((z) => fileEntry(writeDicom(ctSlice({ z })), `CD/DICOM/IM${z}`));
  entries.push(fileEntry(new TextEncoder().encode('not dicom'), 'CD/README.txt'));
  const [s] = await scanEntries(entries);
  assert.equal(s.count, 2);
});

test('groups different series separately, largest first', async () => {
  const a = [0, 1, 2].map((z) => fileEntry(writeDicom(ctSlice({ z, series: '1.1' })), `x/a${z}.dcm`));
  const b = [0].map((z) => fileEntry(writeDicom(ctSlice({ z, series: '2.2' })), `x/b${z}.dcm`));
  const series = await scanEntries([...b, ...a]);
  assert.deepEqual(series.map((s) => s.count), [3, 1]);
});

test('reports compressed transfer syntaxes by name', async () => {
  const elements = ctSlice().map((e) => (e[0] === 0x7fe00010 ? [0x7fe00010, 'OB', null, { undefinedLength: true }] : e));
  const entry = fileEntry(writeDicom(elements, { transfer: '1.2.840.10008.1.2.4.90' }), 'j2k.dcm');
  await assert.rejects(scanEntries([entry]), (err) => err instanceof DicomError && err.code === 'compressed' && err.detail === 'JPEG 2000 Lossless');
});

test('attaches the analysis whose Reference matches the series', async () => {
  const entries = slices([0, 1], { series: '9.9.9' });
  entries.push(fileEntry(new TextEncoder().encode('<trophy type="itoothcontext"/>'), 'scan/Data/Analyses/a.xml'));
  const fakeParse = () => ({ reference: '9.9.9', name: 'Analysis', arches: [], canals: [] });
  const [s] = await scanEntries(entries, null, fakeParse);
  assert.equal(s.analysis?.name, 'Analysis');
});

test('rejects folders without images', async () => {
  const entries = [fileEntry(new TextEncoder().encode('hello'), 'notes.txt')];
  await assert.rejects(scanEntries(entries), (err) => err.code === 'noImages');
});
