// Opens a scan straight from a .zip, the usual way one reaches a phone. Nothing is unpacked
// to disk: entries are read on demand, stored ones sliced from the archive and deflated ones
// inflated by the browser's own DecompressionStream. Handles ZIP64; encryption is refused.

import { DicomError, LIMITS } from './dicom.ts';
import type { Entry, FileLike, Readable } from './dicom.ts';

const EOCD = 0x06054b50, ZIP64_LOCATOR = 0x07064b50, ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;
const DIRECTORY_BYTES = 32 * 1024 * 1024;
// Reads that end within this many bytes inflate only the start of an entry (DICOM headers).
const PREFIX = 256 * 1024;
// The last fully inflated entry is kept this long, so a multi-frame file read frame by frame
// is inflated once rather than once per frame.
const KEEP_MS = 1000;

// One file as the central directory describes it.
export interface ZipRecord {
  name: string;
  flags: number;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

async function view(blob: Blob, start: number, end: number) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

// Inflate raw deflate data, stopping after `length` bytes: a damaged or hostile entry cannot
// produce more than it declared.
async function inflate(blob: Blob, length: number) {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  } catch {
    throw new DicomError('zipUnsupported');
  }
  let out: Uint8Array<ArrayBuffer>;
  try {
    out = new Uint8Array(length);
  } catch {
    throw new DicomError('tooLarge', `${Math.round(length / 1048576)} MB`);
  }
  const reader = stream.getReader();
  let n = 0;
  try {
    while (n < length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, length - n);
      out.set(take < value.length ? value.subarray(0, take) : value, n);
      n += take;
    }
  } catch {
    throw new DicomError('zip');
  } finally {
    reader.cancel().catch(() => {});
  }
  if (n < length) throw new DicomError('zip');
  return out.buffer;
}

let kept: { entry: ZipEntry; promise: Promise<ArrayBuffer>; timer?: ReturnType<typeof setTimeout> } | null = null;

function inflateWhole(entry: ZipEntry) {
  if (kept?.entry !== entry) {
    if (kept) clearTimeout(kept.timer);
    kept = { entry, promise: entry.raw().then((raw) => inflate(raw, entry.size)) };
  }
  const slot = kept;
  clearTimeout(slot.timer);
  slot.timer = setTimeout(() => { if (kept === slot) kept = null; }, KEEP_MS);
  return slot.promise;
}

// A file inside the archive with the parts of the File interface the DICOM reader uses.
class ZipEntry implements FileLike {
  readonly archive: Blob;
  readonly record: ZipRecord;
  readonly size: number;
  readonly name: string;
  private located?: Promise<Blob>;

  constructor(archive: Blob, record: ZipRecord) {
    this.archive = archive;
    this.record = record;
    this.size = record.size;
    this.name = record.name.slice(record.name.lastIndexOf('/') + 1);
  }

  slice(start = 0, end = this.size): Readable & { size: number } {
    return { size: Math.max(0, Math.min(end, this.size) - start), arrayBuffer: () => this.read(start, end) };
  }

  arrayBuffer() {
    return this.read(0, this.size);
  }

  async text() {
    return new TextDecoder().decode(await this.arrayBuffer());
  }

  // The compressed bytes. The local header is read for the data offset, since its extra
  // field may differ from the central directory's.
  raw(): Promise<Blob> {
    this.located ??= (async () => {
      const { offset, compressed } = this.record;
      const h = await view(this.archive, offset, offset + 30);
      if (h.byteLength < 30 || h.getUint32(0, true) !== LOCAL) throw new DicomError('zip');
      const start = offset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
      if (start + compressed > this.archive.size) throw new DicomError('zip');
      return this.archive.slice(start, start + compressed);
    })();
    return this.located;
  }

  async read(start: number, end: number): Promise<ArrayBuffer> {
    start = Math.max(0, Math.min(start, this.size));
    end = Math.max(start, Math.min(end, this.size));
    const { flags, method } = this.record;
    if (flags & 1) throw new DicomError('zipEncrypted');
    if (method !== 0 && method !== 8) throw new DicomError('zipUnsupported');
    if (end === start) return new ArrayBuffer(0);
    const raw = await this.raw();
    if (method === 0) return raw.slice(start, end).arrayBuffer();
    if (end <= PREFIX) return (await inflate(raw, end)).slice(start, end);
    return (await inflateWhole(this)).slice(start, end);
  }
}

// The central directory: one record per file, with ZIP64 sizes and offsets resolved.
export async function readZipDirectory(file: Blob): Promise<ZipRecord[]> {
  const tailStart = Math.max(0, file.size - (22 + 0xffff + 20));
  const tail = await view(file, tailStart, file.size);
  let at = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) { at = i; break; }
  }
  if (at < 0) throw new DicomError('zip');
  let count = tail.getUint16(at + 10, true);
  let size = tail.getUint32(at + 12, true);
  let offset = tail.getUint32(at + 16, true);
  if (at >= 20 && tail.getUint32(at - 20, true) === ZIP64_LOCATOR) {
    const where = Number(tail.getBigUint64(at - 12, true));
    const z = await view(file, where, where + 56);
    if (z.byteLength < 56 || z.getUint32(0, true) !== ZIP64_EOCD) throw new DicomError('zip');
    count = Number(z.getBigUint64(32, true));
    size = Number(z.getBigUint64(40, true));
    offset = Number(z.getBigUint64(48, true));
  }
  if (count > LIMITS.files) throw new DicomError('tooMany', String(count));
  if (size > DIRECTORY_BYTES || offset + size > file.size) throw new DicomError('zip');

  const cd = await view(file, offset, offset + size);
  const names = new TextDecoder();
  const records: ZipRecord[] = [];
  try {
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.getUint32(p, true) !== CENTRAL) throw new DicomError('zip');
      const nameLength = cd.getUint16(p + 28, true);
      const extraLength = cd.getUint16(p + 30, true);
      const record: ZipRecord = {
        name: names.decode(new Uint8Array(cd.buffer, p + 46, nameLength)).replace(/\\/g, '/'),
        flags: cd.getUint16(p + 8, true),
        method: cd.getUint16(p + 10, true),
        compressed: cd.getUint32(p + 20, true),
        size: cd.getUint32(p + 24, true),
        offset: cd.getUint32(p + 42, true),
      };
      // Values that overflowed 32 bits follow in extra field 0x0001, in this order.
      const extraEnd = p + 46 + nameLength + extraLength;
      for (let e = p + 46 + nameLength; e + 4 <= extraEnd;) {
        const id = cd.getUint16(e, true), length = cd.getUint16(e + 2, true);
        if (id === 1) {
          let q = e + 4;
          for (const key of ['size', 'compressed', 'offset'] as const) {
            if (record[key] !== MAX32) continue;
            if (q + 8 > e + 4 + length) throw new DicomError('zip');
            record[key] = Number(cd.getBigUint64(q, true));
            q += 8;
          }
        }
        e += 4 + length;
      }
      p = extraEnd + cd.getUint16(p + 32, true);
      if (!record.name.endsWith('/')) records.push(record);
    }
  } catch (err) {
    throw err instanceof DicomError ? err : new DicomError('zip'); // lengths that run past the directory
  }
  return records;
}

// Replace each .zip among the opened entries with the files inside it.
export async function expandArchives(entries: Entry[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const e of entries) {
    if (!/\.zip$/i.test(e.path) || !(e.file instanceof Blob)) {
      out.push(e);
      continue;
    }
    // macOS adds resource forks (__MACOSX/, ._name) that only look like scan files.
    const records = (await readZipDirectory(e.file)).filter((r) => !/(^|\/)(__MACOSX\/|\._)/.test(r.name));
    if (records.length && records.every((r) => r.flags & 1)) throw new DicomError('zipEncrypted');
    const base = e.path.replace(/\.zip$/i, '');
    for (const r of records) out.push({ file: new ZipEntry(e.file, r), path: `${base}/${r.name}` });
  }
  return out;
}
