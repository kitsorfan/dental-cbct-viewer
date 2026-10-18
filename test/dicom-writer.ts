// Builds small DICOM files in memory so tests never need real patient scans.

import zlib from 'node:zlib';

const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const UNDEF = 0xffffffff;
const DEFLATED = '1.2.840.10008.1.2.1.99';
const utf8 = new TextEncoder();

// One element: [tag, VR, value, options]. A value is text, a US number, a typed array, or for SQ
// (and UN, whose items are then implicit VR) a list of items, each an element list.
// { undefinedLength: true } marks dummy encapsulated data; { fragments, offsets } real encapsulated
// data with a basic offset table.
export type DicomElement = [tag: number, vr: string, value: Value, opts?: ElementOptions];
type Value = string | number | ArrayBufferView | DicomElement[][];
interface ElementOptions { undefinedLength?: boolean; fragments?: Uint8Array[]; offsets?: number[] }

export interface WriteOptions { transfer?: string; preamble?: boolean }
export interface SliceOptions {
  rows?: number;
  cols?: number;
  z?: number;
  instance?: number;
  series?: string;
  pixels?: Uint16Array | Int16Array | Uint8Array;
  signed?: boolean;
  extra?: DicomElement[];
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function u16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
function u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }
function tagBytes(tag: number) { return concat([u16(tag >>> 16), u16(tag & 0xffff)]); }

function valueBytes(vr: string, value: Value): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (vr === 'US') return u16(Number(value));
  let b = utf8.encode(String(value));
  if (b.length % 2) b = concat([b, new Uint8Array([vr === 'UI' ? 0 : 0x20])]);
  return b;
}

function encode(elements: DicomElement[], explicit: boolean): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [tag, vr, value, opts = {}] of elements) {
    const group = tag >>> 16;
    const asExplicit = explicit || group === 0x0002;
    let body: Uint8Array;
    let length: number;
    if (vr === 'SQ' || (vr === 'UN' && Array.isArray(value))) {
      const inner = explicit && vr === 'SQ';
      const items = (value as DicomElement[][]).map((item) => concat([tagBytes(0xfffee000), u32(UNDEF), encode(item, inner), tagBytes(0xfffee00d), u32(0)]));
      body = concat([...items, tagBytes(0xfffee0dd), u32(0)]);
      length = UNDEF;
    } else if (opts.fragments) {
      const table = concat((opts.offsets ?? []).map(u32));
      const items = opts.fragments.map((f) => concat([tagBytes(0xfffee000), u32(f.length), f]));
      body = concat([tagBytes(0xfffee000), u32(table.length), table, ...items, tagBytes(0xfffee0dd), u32(0)]);
      length = UNDEF;
    } else if (opts.undefinedLength) {
      body = concat([tagBytes(0xfffee000), u32(0), tagBytes(0xfffee000), u32(4), new Uint8Array(4), tagBytes(0xfffee0dd), u32(0)]);
      length = UNDEF;
    } else {
      body = valueBytes(vr, value);
      length = body.length;
    }
    if (asExplicit) {
      const vrBytes = utf8.encode(vr);
      parts.push(tagBytes(tag), vrBytes, LONG_VRS.has(vr) ? concat([u16(0), u32(length)]) : u16(length));
    } else {
      parts.push(tagBytes(tag), u32(length));
    }
    parts.push(body);
  }
  return concat(parts);
}

export function writeDicom(elements: DicomElement[], { transfer = '1.2.840.10008.1.2.1', preamble = true }: WriteOptions = {}) {
  const explicit = transfer !== '1.2.840.10008.1.2';
  const meta = encode([[0x00020010, 'UI', transfer]], true);
  let dataset = encode(elements.slice().sort((a, b) => (a[0] >>> 0) - (b[0] >>> 0)), explicit);
  if (transfer === DEFLATED) dataset = new Uint8Array(zlib.deflateRawSync(dataset));
  const head = preamble ? concat([new Uint8Array(128), utf8.encode('DICM')]) : new Uint8Array(0);
  return concat([head, meta, dataset]);
}

// A typical single-frame CT slice; override or add elements through `extra`.
export function ctSlice({ rows = 4, cols = 3, z = 0, instance = 1, series = '1.2.3', pixels, signed = false, extra = [] }: SliceOptions = {}) {
  const n = rows * cols;
  const ramp = (_: number, i: number) => i + z * 100;
  const px = pixels ?? (signed ? new Int16Array(n).map(ramp) : new Uint16Array(n).map(ramp));
  const base: DicomElement[] = [
    [0x00080005, 'CS', 'ISO_IR 192'],
    [0x00080020, 'DA', '20261012'],
    [0x00080060, 'CS', 'CT'],
    [0x00100010, 'PN', 'DOE^JANE'],
    [0x0020000e, 'UI', series],
    [0x00200013, 'IS', String(instance)],
    [0x00200032, 'DS', `-10\\-10\\${z}`],
    [0x00200037, 'DS', '1\\0\\0\\0\\1\\0'],
    [0x00280002, 'US', 1],
    [0x00280010, 'US', rows],
    [0x00280011, 'US', cols],
    [0x00280030, 'DS', '0.5\\0.4'],
    [0x00280100, 'US', 16],
    [0x00280103, 'US', signed ? 1 : 0],
    [0x00281052, 'DS', '-1000'],
    [0x00281053, 'DS', '1'],
    [0x7fe00010, 'OW', px],
  ];
  const tags = new Set(extra.map((e) => e[0]));
  return [...base.filter((e) => !tags.has(e[0])), ...extra];
}

export function fileEntry(bytes: Uint8Array<ArrayBuffer>, path: string) {
  return { file: new File([bytes], path.split('/').pop() ?? path), path };
}
