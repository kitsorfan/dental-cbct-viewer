import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanEntries, loadSeries, parseAnalysis, personName, textDecoder, DicomError } from '../src/dicom.ts';
import type { FileLike } from '../src/dicom.ts';
import { writeDicom, ctSlice, fileEntry } from './dicom-writer.ts';
import type { DicomElement, SliceOptions, WriteOptions } from './dicom-writer.ts';
import { writeJpegLossless, writeRle } from './jpeg-writer.ts';

const code = (c: string) => (err: unknown) => err instanceof DicomError && err.code === c;

const slices = (zs: number[], opts: SliceOptions & { write?: WriteOptions } = {}) => zs.map((z, i) => fileEntry(
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
  const extra: DicomElement[] = [[0x00100010, 'PN', 'ΠΑΠΑΔΟΠΟΥΛΟΣ^ΓΙΩΡΓΟΣ']];
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
  const extra: DicomElement[] = [[0x00091010, 'SQ', [[[0x00091011, 'LO', 'private'], [0x00091012, 'SQ', [[[0x00091013, 'LO', 'nested']]]]]]]];
  const [s] = await scanEntries(slices([0, 1], { extra }));
  const { data } = await loadSeries(s);
  assert.equal(data[13], 101);
});

test('reads headers larger than the first 64 KB', async () => {
  const extra: DicomElement[] = [[0x00091020, 'OB', new Uint8Array(100_000)]];
  const [s] = await scanEntries(slices([0, 1], { extra }));
  const { data } = await loadSeries(s);
  assert.equal(data[12], 100);
});

test('reads a large header without reading the whole file', async () => {
  const extra: DicomElement[] = [[0x00091020, 'OB', new Uint8Array(200_000)]];
  const blob = new Blob([writeDicom(ctSlice({ rows: 1024, cols: 1024, pixels: new Uint16Array(1024 * 1024), extra }))]);
  const reads: number[] = [];
  const file: FileLike = {
    size: blob.size,
    text: () => blob.text(),
    arrayBuffer: () => { reads.push(blob.size); return blob.arrayBuffer(); },
    slice: (start = 0, end = blob.size) => { reads.push(end - start); return blob.slice(start, end); },
  };
  const [s] = await scanEntries([{ file, path: 'big.dcm' }]);
  assert.equal(s.count, 1);
  assert.ok(Math.max(...reads) <= 1024 * 1024, `largest read: ${Math.max(...reads)} of ${blob.size} bytes`);
});

test('spaces slices without positions by their spacing, in Instance Number or file name order', async () => {
  const noPosition = (z: number, extra: DicomElement[] = []) => ctSlice({ z, instance: z + 1, extra: [[0x00180050, 'DS', '0.2'], ...extra] })
    .filter((e) => e[0] !== 0x00200032);
  const [s] = await scanEntries([2, 0, 1].map((z) => fileEntry(writeDicom(noPosition(z)), `scan/s${9 - z}.dcm`)));
  const { meta, data } = await loadSeries(s);
  assert.ok(Math.abs(meta.spacing[2] - 0.2) < 1e-9, `spacing ${meta.spacing[2]}`);
  assert.deepEqual([data[0], data[12], data[24]], [0, 100, 200]);

  const unnumbered = [2, 0, 10, 1].map((z) => fileEntry(writeDicom(noPosition(z).filter((e) => e[0] !== 0x00200013)), `scan/IM${z}`));
  const { data: byName } = await loadSeries((await scanEntries(unnumbered))[0]);
  assert.deepEqual([0, 1, 2, 3].map((k) => byName[k * 12]), [0, 100, 200, 1000]);
});

test('sign-extends signed pixels from Bits Stored', async () => {
  // 12-bit two's complement with the top bits left clear, as some scanners write it.
  const values = [-1000, -1, 0, 2047, -2048, 500, 1, 2, 3, 4, 5, 6];
  const pixels = new Uint16Array(values.map((v) => v & 0xfff));
  const [s] = await scanEntries(slices([0], { signed: true, pixels, extra: [[0x00280101, 'US', 12]] }));
  const { meta, data } = await loadSeries(s);
  values.forEach((v, i) => assert.equal(data[i] * meta.slope + meta.intercept, v - 1000));
});

test('reads signed 8-bit pixels', async () => {
  const pixels = new Int8Array([-128, -1, 0, 1, 127, 5, 6, 7, 8, 9, 10, 11]);
  const extra: DicomElement[] = [[0x00280100, 'US', 8], [0x00280103, 'US', 1], [0x7fe00010, 'OB', pixels]];
  const [s] = await scanEntries(slices([0], { extra }));
  const { meta, data } = await loadSeries(s);
  pixels.forEach((v, i) => assert.equal(data[i] * meta.slope + meta.intercept, v - 1000));
});

test('marks MONOCHROME1 scans to be shown inverted', async () => {
  const load = async (photometric: string) => (await loadSeries((await scanEntries(slices([0], { extra: [[0x00280004, 'CS', photometric]] })))[0])).meta;
  assert.equal((await load('MONOCHROME1')).inverted, true);
  assert.equal((await load('MONOCHROME2')).inverted, false);
});

test('reads undefined-length UN elements as implicit VR', async () => {
  // A private sequence that an anonymizer re-encoded as UN: its items stay implicit VR.
  const extra: DicomElement[] = [[0x00091010, 'UN', [[[0x00091011, 'LO', 'ABCDEF'], [0x00091012, 'LO', 'xyz']]]]];
  const [s] = await scanEntries(slices([0, 1], { extra }));
  const { data } = await loadSeries(s);
  assert.equal(data[13], 101);
});

test('reads deflated DICOM', async () => {
  const [s] = await scanEntries(slices([0, 1], { write: { transfer: '1.2.840.10008.1.2.1.99' } }));
  assert.equal(s.patientName, 'DOE JANE');
  const { meta, data } = await loadSeries(s);
  assert.deepEqual(meta.dims, [3, 4, 2]);
  assert.equal(data[12], 100);
});

test('decodes Japanese, Korean and Chinese names', () => {
  const bytes = (hex: string) => new Uint8Array(hex.split(' ').map((h) => parseInt(h, 16)));
  // The examples of DICOM PS3.5 Annexes H, I and J.
  const japanese = bytes('59 61 6d 61 64 61 5e 54 61 72 6f 75 3d 1b 24 42 3b 33 45 44 1b 28 42 5e 1b 24 42 42 40 4f 3a 1b 28 42 3d 1b 24 42 24 64 24 5e 24 40 1b 28 42 5e 1b 24 42 24 3f 24 6d 24 26 1b 28 42');
  assert.equal(textDecoder('\\ISO 2022 IR 87')(japanese), 'Yamada^Tarou=山田^太郎=やまだ^たろう');
  const katakana = bytes('d4 cf c0 de 5e c0 db b3 3d 1b 24 42 3b 33 45 44 1b 28 4a 5e 1b 24 42 42 40 4f 3a 1b 28 4a');
  assert.equal(textDecoder('ISO 2022 IR 13\\ISO 2022 IR 87')(katakana), 'ﾔﾏﾀﾞ^ﾀﾛｳ=山田^太郎');
  const korean = bytes('48 6f 6e 67 5e 47 69 6c 64 6f 6e 67 3d 1b 24 29 43 fb f3 5e 1b 24 29 43 d1 ce d4 d7 3d 1b 24 29 43 c8 ab 5e 1b 24 29 43 b1 e6 b5 bf');
  assert.equal(textDecoder('\\ISO 2022 IR 149')(korean), 'Hong^Gildong=洪^吉洞=홍^길동');
  const chinese = bytes('57 61 6e 67 5e 58 69 61 6f 44 6f 6e 67 3d cd f5 5e d0 a1 b6 ab 3d');
  assert.equal(textDecoder('GB18030')(chinese), 'Wang^XiaoDong=王^小东=');
  assert.equal(personName('=山田^太郎'), '山田 太郎');
});

test('turns coronal and mirrored scans to the patient axes', async () => {
  const rows = 4, cols = 3;
  // Each voxel holds column + 10 × row + 100 × slice, as stored.
  const pixels = (k: number) => new Uint16Array(rows * cols).map((_, i) => (i % cols) + 10 * Math.floor(i / cols) + 100 * k);
  const open = async (orientation: string, position: (k: number) => string) => {
    const entries = [0, 1, 2].map((k) => fileEntry(writeDicom(ctSlice({
      rows, cols, instance: k + 1, pixels: pixels(k),
      extra: [[0x00200037, 'DS', orientation], [0x00200032, 'DS', position(k)]],
    })), `scan/s${k}.dcm`));
    return loadSeries((await scanEntries(entries))[0]);
  };

  // Coronal slices: rows run inferior, slices posterior.
  const coronal = await open('1\\0\\0\\0\\0\\-1', (k) => `0\\${k * 0.7}\\0`);
  assert.deepEqual(coronal.meta.dims, [3, 3, 4]);
  assert.deepEqual(coronal.meta.spacing.map((v) => +v.toFixed(3)), [0.4, 0.7, 0.5]);
  const cor = (x: number, y: number, z: number) => coronal.data[z * 9 + y * 3 + x];
  assert.equal(cor(2, 1, 3), 2 + 10 * 0 + 100 * 1, 'the top row is the most superior');
  assert.equal(cor(0, 2, 0), 0 + 10 * 3 + 100 * 2);

  // Axial slices stored mirrored and from the top down.
  const mirrored = await open('-1\\0\\0\\0\\1\\0', (k) => `0\\0\\${k}`);
  assert.deepEqual(mirrored.meta.dims, [3, 4, 3]);
  const mir = (x: number, y: number, z: number) => mirrored.data[z * 12 + y * 3 + x];
  assert.equal(mir(0, 0, 2), 2 + 200, 'the patient right is on the left');
  assert.equal(mir(2, 3, 0), 30);
});

test('a stray .dcm does not hide a volume stored without extensions', async () => {
  const entries = [0, 1, 2].map((z) => fileEntry(writeDicom(ctSlice({ z, series: '1.1' })), `CD/DICOM/IM${z}`));
  entries.push(fileEntry(writeDicom(ctSlice({ series: '2.2' })), 'CD/sample.dcm'));
  const series = await scanEntries(entries);
  assert.deepEqual(series.map((s) => s.count), [3, 1]);
});

test('reads multi-frame images using per-frame positions', async () => {
  const rows = 2, cols = 2;
  const pixels = new Uint16Array([...Array(4).fill(30), ...Array(4).fill(10), ...Array(4).fill(20)]);
  const frame = (z: number): DicomElement[] => [[0x00209113, 'SQ', [[[0x00200032, 'DS', `0\\0\\${z}`]]]]];
  const extra: DicomElement[] = [
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
  const elements = ctSlice().map((e): DicomElement => (e[0] === 0x7fe00010 ? [0x7fe00010, 'OB', '', { undefinedLength: true }] : e));
  const entry = fileEntry(writeDicom(elements, { transfer: '1.2.840.10008.1.2.4.90' }), 'j2k.dcm');
  await assert.rejects(scanEntries([entry]), (err) => err instanceof DicomError && err.code === 'compressed' && err.detail === 'JPEG 2000 Lossless');
});

const JPEG_LOSSLESS = '1.2.840.10008.1.2.4.70', RLE = '1.2.840.10008.1.2.5';
// Frame f of a 3 × 4 image holds pixel index + 100 × f + 3000.
const framePixels = (f: number) => new Uint16Array(12).map((_, i) => i + 100 * f + 3000);
const encapsulated = (fragments: Uint8Array[], offsets: number[] = []): DicomElement => [0x7fe00010, 'OB', '', { fragments, offsets }];

test('reads JPEG Lossless scans', async () => {
  const entries = [0, 1].map((z) => fileEntry(writeDicom(ctSlice({
    z, instance: z + 1, extra: [encapsulated([writeJpegLossless(framePixels(z), 3, 4, { precision: 16, predictor: 1 })])],
  }), { transfer: JPEG_LOSSLESS }), `jpeg/s${z}.dcm`));
  const { data } = await loadSeries((await scanEntries(entries))[0]);
  assert.deepEqual([data[0], data[11], data[12], data[23]], [3000, 3011, 3100, 3111]);
});

test('reads signed 12-bit JPEG Lossless pixels', async () => {
  const values = [-1000, -1, 0, 2047, -2048, 500, 1, 2, 3, 4, 5, 6];
  const jpeg = writeJpegLossless(values.map((v) => v & 0xfff), 3, 4, { precision: 12, predictor: 7 });
  const extra: DicomElement[] = [[0x00280101, 'US', 12], [0x00280103, 'US', 1], encapsulated([jpeg])];
  const [s] = await scanEntries([fileEntry(writeDicom(ctSlice({ extra }), { transfer: JPEG_LOSSLESS }), 'signed.dcm')]);
  const { meta, data } = await loadSeries(s);
  values.forEach((v, i) => assert.equal(data[i] * meta.slope + meta.intercept, v - 1000));
});

test('splits multi-frame compressed data into its frames', async () => {
  const jpegs = [0, 1, 2].map((f) => writeJpegLossless(framePixels(f), 3, 4, { precision: 16, predictor: 6 }));
  const split = [jpegs[0].subarray(0, 10), jpegs[0].subarray(10), jpegs[1], jpegs[2]];
  const item = (b: Uint8Array) => 8 + b.length;
  const table = [0, item(split[0]) + item(split[1]), item(split[0]) + item(split[1]) + item(split[2])];
  const cases: [string, Uint8Array[], number[]][] = [
    ['offset table', split, table], ['one fragment per frame', jpegs, []], ['start-of-image markers', split, []],
  ];
  for (const [name, fragments, offsets] of cases) {
    const extra: DicomElement[] = [[0x00280008, 'IS', '3'], encapsulated(fragments, offsets)];
    const [s] = await scanEntries([fileEntry(writeDicom(ctSlice({ extra }), { transfer: JPEG_LOSSLESS }), 'multi.dcm')]);
    assert.equal(s.count, 3, name);
    const { data } = await loadSeries(s);
    assert.deepEqual([data[0], data[12], data[35]], [3000, 3100, 3211], name);
  }
});

test('reads RLE Lossless scans', async () => {
  const entries = [0, 1].map((z) => fileEntry(writeDicom(ctSlice({
    z, instance: z + 1, extra: [encapsulated([writeRle(framePixels(z), 4, 3)])],
  }), { transfer: RLE }), `rle/s${z}.dcm`));
  const { data } = await loadSeries((await scanEntries(entries))[0]);
  assert.deepEqual([data[0], data[11], data[12], data[23]], [3000, 3011, 3100, 3111]);
});

test('reports damaged and unsupported compressed frames clearly', async () => {
  const open = async (fragment: Uint8Array) => loadSeries((await scanEntries([
    fileEntry(writeDicom(ctSlice({ extra: [encapsulated([fragment])] }), { transfer: JPEG_LOSSLESS }), 'x.dcm'),
  ]))[0]);
  const jpeg = writeJpegLossless(framePixels(0), 3, 4, { precision: 16, predictor: 1 });
  await assert.rejects(open(jpeg.subarray(0, jpeg.length - 12)), code('invalid'));
  // A lossy (baseline) JPEG inside a file that claims to be lossless.
  const baseline = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 4, 0, 3, 1, 1, 0x11, 0, 0xff, 0xd9]);
  await assert.rejects(open(baseline), (err) => err instanceof DicomError && err.code === 'compressed' && err.detail === 'JPEG Baseline');
});

test('attaches the analysis whose Reference matches the series', async () => {
  const entries = slices([0, 1], { series: '9.9.9' });
  entries.push(fileEntry(new TextEncoder().encode('<trophy type="itoothcontext"/>'), 'scan/Data/Analyses/a.xml'));
  const fakeParse = () => ({ reference: '9.9.9', name: 'Analysis', arches: [], canals: [], lut: null, ortho: null });
  const [s] = await scanEntries(entries, null, fakeParse);
  assert.equal(s.analysis?.name, 'Analysis');
});

test('rejects folders without images', async () => {
  const entries = [fileEntry(new TextEncoder().encode('hello'), 'notes.txt')];
  await assert.rejects(scanEntries(entries), code('noImages'));
});

test('rejects implausible image sizes before allocating anything', async () => {
  const extra: DicomElement[] = [[0x00280010, 'US', 60000], [0x00280011, 'US', 60000]];
  const entry = fileEntry(writeDicom(ctSlice({ extra })), 'huge.dcm');
  await assert.rejects(scanEntries([entry]), code('dims'));
});

test('rejects absurdly deep nesting', async () => {
  let item: DicomElement[] = [[0x00091011, 'LO', 'x']];
  for (let i = 0; i < 40; i++) item = [[0x00091010, 'SQ', [item]]];
  const entry = fileEntry(writeDicom(ctSlice({ extra: item })), 'deep.dcm');
  await assert.rejects(scanEntries([entry]), code('invalid'));
});

test('reports garbage files as damaged rather than crashing', async () => {
  const bytes = new Uint8Array(400);
  bytes.set(new TextEncoder().encode('DICM'), 128);
  for (let i = 132; i < 400; i++) bytes[i] = (i * 37) & 0xff;
  await assert.rejects(scanEntries([fileEntry(bytes, 'noise.dcm')]), (err) => err instanceof DicomError);
});

test('refuses to open an unreasonable number of files', async () => {
  const entries = Array.from({ length: 20001 }, (_, i) => ({ file: new File([], `f${i}`), path: `f${i}` }));
  await assert.rejects(scanEntries(entries), code('tooMany'));
});

test('ignores analysis files that declare a DTD or entities', () => {
  assert.equal(parseAnalysis('<!DOCTYPE t [<!ENTITY a "b">]><trophy type="itoothcontext">&a;</trophy>'), null);
});
