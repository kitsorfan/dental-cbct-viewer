import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { scanEntries, loadSeries, DicomError } from '../src/dicom.ts';
import { expandArchives, readZipDirectory } from '../src/zip.ts';
import { writeDicom, ctSlice, fileEntry } from './dicom-writer.ts';

interface ZipFile {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  size?: number;
}

// Builds a ZIP in memory. files: [{ name, data, method = 8, flags = 0, size }]; `size` overrides
// the declared uncompressed size. zip64 writes every size and offset through ZIP64 records.
function makeZip(files: ZipFile[], { zip64 = false } = {}) {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = Buffer.from(f.data);
    const method = f.method ?? 8;
    const body = method === 0 ? data : zlib.deflateRawSync(data);
    const size = f.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(f.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(45, 4);
    c.writeUInt16LE(45, 6);
    c.writeUInt16LE(f.flags ?? 0, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    c.writeUInt32LE(zip64 ? 0xffffffff : size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(c, name, extra);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (zip64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeBigUInt64LE(BigInt(files.length), 24);
    z.writeBigUInt64LE(BigInt(files.length), 32);
    z.writeBigUInt64LE(BigInt(cd.length), 40);
    z.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(z, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, ...tail, eocd]));
}

// 400 × 400 slices are larger than the reader's header window, so pixel reads inflate whole entries.
const slice = (z: number) => writeDicom(ctSlice({ rows: 400, cols: 400, z, instance: z + 1 }));
const scanFiles = () => [
  { name: 'Patient/Data/s2.dcm', data: slice(2) },
  { name: 'Patient/Data/s0.dcm', data: slice(0), method: 0 },
  { name: 'Patient/Data/s1.dcm', data: slice(1) },
  { name: 'Patient/', data: new Uint8Array(0), method: 0 },
  { name: '__MACOSX/Patient/Data/._s0.dcm', data: new Uint8Array(200) },
];

async function openZip(bytes: Uint8Array<ArrayBuffer>) {
  const entries = await expandArchives([fileEntry(bytes, 'scan.zip')]);
  const [series] = await scanEntries(entries);
  return { entries, series, ...(await loadSeries(series)) };
}

test('opens a scan straight from a ZIP, stored or deflated', async () => {
  const { entries, series, meta, data } = await openZip(makeZip(scanFiles()));
  assert.deepEqual(entries.map((e) => e.path).sort(), ['scan/Patient/Data/s0.dcm', 'scan/Patient/Data/s1.dcm', 'scan/Patient/Data/s2.dcm']);
  assert.equal(series.count, 3);
  assert.equal(series.patientName, 'DOE JANE');
  assert.deepEqual(meta.dims, [400, 400, 3]);
  const n = 400 * 400;
  assert.deepEqual([data[0], data[n], data[2 * n], data[2 * n + 7]], [0, 100, 200, 207]);
});

test('reads ZIP64 archives', async () => {
  const { series, data } = await openZip(makeZip(scanFiles(), { zip64: true }));
  assert.equal(series.count, 3);
  assert.equal(data[400 * 400], 100);
});

test('mixes archives with loose files and keeps their paths apart', async () => {
  const zip = makeZip([{ name: 'a.dcm', data: slice(0) }]);
  const entries = await expandArchives([fileEntry(zip, 'Downloads/scan.zip'), fileEntry(slice(1), 'other/b.dcm')]);
  assert.deepEqual(entries.map((e) => e.path), ['Downloads/scan/a.dcm', 'other/b.dcm']);
});

test('never inflates more than an entry declares', async () => {
  const [entry] = await expandArchives([fileEntry(makeZip([{ name: 'x.dcm', data: new Uint8Array(500000).fill(7), size: 1000 }]), 'x.zip')]);
  assert.equal(entry.file.size, 1000);
  const bytes = new Uint8Array(await entry.file.arrayBuffer());
  assert.equal(bytes.length, 1000);
  assert.equal(bytes[999], 7);
  assert.deepEqual([...new Uint8Array(await entry.file.slice(10, 13).arrayBuffer())], [7, 7, 7]);
});

test('refuses encrypted, damaged and non-ZIP files with a clear error', async () => {
  const code = (c: string) => (err: unknown) => err instanceof DicomError && err.code === c;
  const encrypted = makeZip([{ name: 'a.dcm', data: slice(0), flags: 1 }]);
  await assert.rejects(expandArchives([fileEntry(encrypted, 'a.zip')]), code('zipEncrypted'));

  await assert.rejects(expandArchives([fileEntry(new TextEncoder().encode('just text'), 'fake.zip')]), code('zip'));
  const good = makeZip(scanFiles());
  await assert.rejects(readZipDirectory(new File([good.slice(0, good.length - 30)], 'cut.zip')), code('zip'));

  // Rewrite the compression method in both the local and the central header of a one-file archive.
  const withMethod = (zip: Uint8Array<ArrayBuffer>, method: number) => {
    const cd = Buffer.from(zip).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.set([method, 0], 8);
    zip.set([method, 0], cd + 10);
    return zip;
  };
  const corrupt = withMethod(makeZip([{ name: 'a.dcm', data: new Uint8Array(400), method: 0 }]), 8);
  const [entry] = await expandArchives([fileEntry(corrupt, 'b.zip')]);
  await assert.rejects(entry.file.arrayBuffer(), code('zip'));

  const lzma = withMethod(makeZip([{ name: 'a.dcm', data: slice(0) }]), 14);
  const [unsupported] = await expandArchives([fileEntry(lzma, 'c.zip')]);
  await assert.rejects(unsupported.file.arrayBuffer(), code('zipUnsupported'));
});
