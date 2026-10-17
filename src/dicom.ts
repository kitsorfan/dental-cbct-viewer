// In-browser DICOM loading: groups local files into series and assembles a uint16 volume.
// Handles single-frame series and multi-frame (enhanced) images in uncompressed
// little-endian transfer syntaxes.

import type { Point } from './reslice.ts';

export class DicomError extends Error {
  code: string;
  detail: string;

  constructor(code: string, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

// The parts of File the reader uses, so the files inside a ZIP can stand in for real ones.
export interface Readable {
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface FileLike extends Readable {
  readonly size: number;
  slice(start?: number, end?: number): Readable;
  text(): Promise<string>;
}

// A file to open, with its '/'-separated path relative to what the user picked.
export interface Entry {
  file: FileLike;
  path: string;
}

// Header values the viewer reads. US values are numbers; everything else is text.
export interface DicomFields {
  charset?: string;
  studyDate?: string;
  modality?: string;
  manufacturer?: string;
  model?: string;
  description?: string;
  patientName?: string;
  patientId?: string;
  birthDate?: string;
  sliceThickness?: string;
  kvp?: string;
  spacingBetween?: string;
  seriesUid?: string;
  instance?: string;
  position?: string;
  orientation?: string;
  comments?: string;
  samples?: number;
  frames?: string;
  rows?: number;
  cols?: number;
  pixelSpacing?: string;
  bits?: number;
  signed?: number;
  windowCenter?: string;
  windowWidth?: string;
  intercept?: string;
  slope?: string;
}

export interface DicomInfo extends DicomFields {
  framePositions: string[];
  pixelOffset: number;
  pixelLength: number;
  transfer: string;
}

// Files that hold an image: the only ones grouped into series.
export interface ImageInfo extends DicomInfo {
  rows: number;
  cols: number;
}

export interface AnalysisArch { id: string; type: string; name: string; points: Point[] }
export interface AnalysisCanal { name: string; radius: number; color: number[]; points: Point[] }
export interface WindowLevel { center: number; width: number }

// What a CS 3D Imaging analysis file contributes.
export interface Analysis {
  name: string;
  reference: string;
  arches: AnalysisArch[];
  canals: AnalysisCanal[];
  lut: WindowLevel | null;
  ortho: number[] | null;
}

export interface Series {
  id: string;
  slices: { file: FileLike; info: ImageInfo }[];
  analysis: Analysis | null;
  dir: string;
  patientName: string;
  studyDate: string;
  count: number;
}

// Everything the viewer knows about an opened scan besides its voxels.
export interface ScanMeta {
  dims: [number, number, number];
  spacing: [number, number, number];
  slope: number;
  intercept: number;
  window: WindowLevel | null;
  percentiles: number[];
  max: number;
  demo?: boolean;
  patientName: string;
  patientId: string;
  birthDate: string;
  studyDate: string;
  model: string;
  manufacturer: string;
  kvp: string;
  comments: string;
  analysis: Analysis | null;
}

const ITEM = 0xfffee000, ITEM_DELIM = 0xfffee00d, SEQ_DELIM = 0xfffee0dd, PIXEL_DATA = 0x7fe00010;
const SHARED = 0x52009229, PER_FRAME = 0x52009230;
// Functional-group sequences worth descending into; every other sequence is skipped.
const DESCEND = new Set([SHARED, PER_FRAME, 0x00289110, 0x00209113, 0x00209116, 0x00289145, 0x00289132]);
const UNDEF = 0xffffffff;
const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const HEADER_BYTES = 64 * 1024;
const IMPLICIT_LE = '1.2.840.10008.1.2';
const EXPLICIT_LE = '1.2.840.10008.1.2.1';

// Limits that keep hostile or damaged input from hanging or exhausting the browser.
export const LIMITS = {
  volumeBytes: 1.6e9,
  files: 20000,
  dimension: 4096,
  frames: 10000,
  nesting: 24,
  xmlBytes: 5e6,
  curvePoints: 2000,
  curves: 50,
};

type Field = keyof DicomFields;

const WANTED: Record<number, [Field, string]> = {
  0x00080005: ['charset', 'CS'],
  0x00080020: ['studyDate', 'DA'],
  0x00080060: ['modality', 'CS'],
  0x00080070: ['manufacturer', 'LO'],
  0x00081090: ['model', 'LO'],
  0x0008103e: ['description', 'LO'],
  0x00100010: ['patientName', 'PN'],
  0x00100020: ['patientId', 'LO'],
  0x00100030: ['birthDate', 'DA'],
  0x00180050: ['sliceThickness', 'DS'],
  0x00180060: ['kvp', 'DS'],
  0x00180088: ['spacingBetween', 'DS'],
  0x0020000e: ['seriesUid', 'UI'],
  0x00200013: ['instance', 'IS'],
  0x00200032: ['position', 'DS'],
  0x00200037: ['orientation', 'DS'],
  0x00204000: ['comments', 'LT'],
  0x00280002: ['samples', 'US'],
  0x00280008: ['frames', 'IS'],
  0x00280010: ['rows', 'US'],
  0x00280011: ['cols', 'US'],
  0x00280030: ['pixelSpacing', 'DS'],
  0x00280100: ['bits', 'US'],
  0x00280103: ['signed', 'US'],
  0x00281050: ['windowCenter', 'DS'],
  0x00281051: ['windowWidth', 'DS'],
  0x00281052: ['intercept', 'DS'],
  0x00281053: ['slope', 'DS'],
};

const CHARSETS: Record<string, string> = {
  'ISO_IR 192': 'utf-8', 'ISO_IR 100': 'windows-1252', 'ISO_IR 101': 'iso-8859-2',
  'ISO_IR 126': 'iso-8859-7', 'ISO_IR 144': 'iso-8859-5', 'ISO_IR 148': 'windows-1254',
};

const COMPRESSED: Record<string, string> = {
  '1.2.840.10008.1.2.5': 'RLE Lossless',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.4.201': 'HTJ2K Lossless',
  '1.2.840.10008.1.2.4.203': 'HTJ2K',
};

class NeedMore extends Error {}

// Parse everything up to the pixel data. Throws NeedMore if the buffer ends first.
export function parseHeader(buffer: ArrayBuffer): DicomInfo {
  const len = buffer.byteLength;
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const isVr = (a: number, b: number) => a >= 65 && a <= 90 && b >= 65 && b <= 90;
  const preamble = len > 132 && u8[128] === 0x44 && u8[129] === 0x49 && u8[130] === 0x43 && u8[131] === 0x4d;
  if (!preamble) {
    const group = len >= 8 ? dv.getUint16(0, true) : -1;
    if (group !== 0x0002 && group !== 0x0008) throw new DicomError('notDicom');
  }
  let explicit = preamble || isVr(u8[4], u8[5]);
  let transfer = explicit ? EXPLICIT_LE : IMPLICIT_LE;
  let decoder = new TextDecoder('windows-1252');
  // Top-level values win over the same values found inside functional groups.
  const top: Record<string, string | number> = {};
  const nested: Record<string, string | number> = {};
  const framePositions: string[] = [];
  let pixelOffset = -1, pixelLength = 0;

  interface Head { tag: number; vr: string | null; length: number; size: number }
  interface Context { top?: boolean; skip?: boolean; frame?: number; seq?: number }

  const head = (p: number): Head => {
    if (p + 8 > len) throw new NeedMore();
    const group = dv.getUint16(p, true), elem = dv.getUint16(p + 2, true);
    const tag = ((group << 16) | elem) >>> 0;
    if (group === 0xfffe) return { tag, vr: null, length: dv.getUint32(p + 4, true), size: 8 };
    if (explicit || group === 0x0002) {
      const vr = String.fromCharCode(u8[p + 4], u8[p + 5]);
      if (LONG_VRS.has(vr)) {
        if (p + 12 > len) throw new NeedMore();
        return { tag, vr, length: dv.getUint32(p + 8, true), size: 12 };
      }
      return { tag, vr, length: dv.getUint16(p + 6, true), size: 8 };
    }
    const vr = DESCEND.has(tag) ? 'SQ' : WANTED[tag]?.[1] ?? 'UN';
    return { tag, vr, length: dv.getUint32(p + 4, true), size: 8 };
  };

  const text = (p: number, n: number) => decoder.decode(u8.subarray(p, p + n)).replace(/[\0\s]+$/, '').replace(/^\s+/, '');

  const store = (h: Head, p: number, ctx: Context) => {
    const want = WANTED[h.tag];
    if (!want || ctx.skip) return;
    if (p + h.length > len) throw new NeedMore();
    const [key, vr] = want;
    const value = vr === 'US' ? (h.length >= 2 ? dv.getUint16(p, true) : 0) : text(p, h.length);
    if (ctx.top) {
      top[key] = value;
      if (key === 'charset' && typeof value === 'string') {
        const name = CHARSETS[(value.split('\\').pop() ?? '').trim()];
        if (name) decoder = new TextDecoder(name);
      }
    } else if (ctx.frame !== undefined && key === 'position') {
      framePositions[ctx.frame] = String(value);
    } else if (!(key in nested)) {
      nested[key] = value;
    }
  };

  // Elements from p until `end` or an item delimiter; returns the position after them,
  // or -1 once the top-level pixel data is reached.
  const walk = (p: number, end: number, ctx: Context): number => {
    while (p < end) {
      const h = head(p);
      if (h.tag === ITEM_DELIM) return p + 8;
      if (ctx.top && h.tag === PIXEL_DATA) {
        if (h.length === UNDEF) throw new DicomError('compressed', COMPRESSED[transfer] || transfer);
        pixelOffset = p + h.size;
        pixelLength = h.length;
        return -1;
      }
      const value = p + h.size;
      if (h.vr === 'SQ' || h.length === UNDEF) {
        const inner: Context = ctx.skip || !DESCEND.has(h.tag) ? { skip: true } : { frame: ctx.frame, seq: h.tag };
        p = sequence(value, h.length, inner);
        continue;
      }
      if (h.tag === 0x00020010) {
        // File meta is always explicit VR; the transfer syntax decides the dataset's encoding.
        transfer = text(value, h.length);
        if (transfer === '1.2.840.10008.1.2.2') throw new DicomError('bigEndian');
        if (transfer === '1.2.840.10008.1.2.1.99') throw new DicomError('deflated');
        explicit = transfer !== IMPLICIT_LE;
      }
      store(h, value, ctx);
      p = value + h.length;
    }
    return p;
  };

  let depth = 0;
  const sequence = (p: number, length: number, ctx: Context) => {
    if (++depth > LIMITS.nesting) throw new DicomError('invalid');
    const end = length === UNDEF ? Infinity : p + length;
    let index = 0;
    while (p < end) {
      const h = head(p);
      p += 8;
      if (h.tag === SEQ_DELIM) break;
      if (h.tag !== ITEM) {
        if (h.length !== UNDEF) p += h.length;
        continue;
      }
      if (ctx.skip && h.length !== UNDEF) {
        p += h.length;
      } else {
        const itemEnd = h.length === UNDEF ? Infinity : p + h.length;
        const itemCtx = ctx.skip ? ctx : { frame: ctx.seq === PER_FRAME ? index : ctx.frame };
        p = walk(p, itemEnd, itemCtx);
      }
      index++;
    }
    depth--;
    return p;
  };

  walk(preamble ? 132 : 0, Infinity, { top: true });
  // WANTED decides each field's type: numbers for US, text for the rest.
  const out = { ...nested, ...top, framePositions, pixelOffset, pixelLength, transfer } as DicomInfo;

  const frames = num(out.frames, 1);
  if ((out.rows ?? 0) > LIMITS.dimension || (out.cols ?? 0) > LIMITS.dimension || frames > LIMITS.frames || frames < 1) {
    throw new DicomError('dims', `${out.cols}×${out.rows}×${frames}`);
  }
  return out;
}

async function readHeader(file: FileLike): Promise<DicomInfo> {
  const attempt = async (blob: Readable) => {
    try {
      return parseHeader(await blob.arrayBuffer());
    } catch (err) {
      if (err instanceof DicomError) throw err;
      if (!(err instanceof NeedMore)) throw new DicomError('invalid'); // malformed lengths or offsets
      return null;
    }
  };
  if (file.size > HEADER_BYTES) {
    const info = await attempt(file.slice(0, HEADER_BYTES));
    if (info) return info;
  }
  const info = await attempt(file);
  if (!info) throw new DicomError('noPixels');
  return info;
}

const nums = (s: string | number | undefined) => (s ? String(s).split('\\').map(Number).filter((v) => !Number.isNaN(v)) : []);
const num = (s: string | number | undefined, d: number) => { const v = nums(s)[0]; return v === undefined ? d : v; };

export function personName(s: string | undefined) {
  if (!s) return '';
  return s.split('=')[0].split('^').map((p) => p.trim()).filter(Boolean).slice(0, 2).join(' ');
}

export function formatDate(s: string | undefined) {
  return s && /^\d{8}$/.test(s) ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : s || '';
}

const hasImage = (info: DicomInfo): info is ImageInfo => !!(info.rows && info.cols);

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function hasDicomMagic(file: FileLike) {
  if (file.size < 132) return false;
  const b = new Uint8Array(await file.slice(128, 132).arrayBuffer());
  return b[0] === 0x44 && b[1] === 0x49 && b[2] === 0x43 && b[3] === 0x4d;
}

// entries: [{ file, path }] with '/'-separated relative paths. Returns series, largest first.
export async function scanEntries(entries: Entry[], onProgress?: ((fraction: number) => void) | null,
  parseXml: (text: string) => Analysis | null = parseAnalysis): Promise<Series[]> {
  if (entries.length > LIMITS.files) throw new DicomError('tooMany', String(entries.length));
  const lower = (e: Entry) => e.path.toLowerCase();
  let candidates = entries.filter((e) => lower(e).endsWith('.dcm') || lower(e).endsWith('.dicom'));
  if (!candidates.length) {
    const others = entries.filter((e) => !/\.(xml|txt|exe|dll|ini|html?|jpe?g|png|pdf|zip|js|css|json)$/i.test(e.path)
      && !/(^|\/)dicomdir$/i.test(e.path));
    const flags = await Promise.all(others.map((e) => hasDicomMagic(e.file)));
    candidates = others.filter((_, i) => flags[i]);
  }

  interface Group { key: string; dir: string; uid: string; slices: Series['slices'] }
  const groups = new Map<string, Group>();
  let done = 0;
  let firstError: unknown = null;
  await pool(candidates, 16, async (e) => {
    try {
      const info = await readHeader(e.file);
      if (hasImage(info)) {
        const key = `${info.seriesUid || ''}|${dirOf(e.path)}`;
        let group = groups.get(key);
        if (!group) groups.set(key, group = { key, dir: dirOf(e.path), uid: info.seriesUid || '', slices: [] });
        group.slices.push({ file: e.file, info });
      }
    } catch (err) {
      if (!firstError || (err instanceof DicomError && err.code === 'compressed')) firstError = err;
    }
    done++;
    if (onProgress && done % 8 === 0) onProgress(done / candidates.length);
  });

  const analyses: (Analysis & { path: string })[] = [];
  for (const e of entries.filter((x) => lower(x).endsWith('.xml') && x.file.size < LIMITS.xmlBytes)) {
    const text = await e.file.text();
    if (!text.includes('itoothcontext')) continue;
    try {
      const parsed = parseXml(text);
      if (parsed) analyses.push({ path: e.path, ...parsed });
    } catch {
      // an unreadable analysis only means no arches or canals
    }
  }

  const series = [...groups.values()].map((g): Series => {
    const first = g.slices[0].info;
    const frames = g.slices.reduce((n, s) => n + Math.max(1, num(s.info.frames, 1)), 0);
    const analysis =
      analyses.find((a) => a.reference && a.reference === g.uid) ||
      analyses.find((a) => dirOf(a.path) === `${g.dir}/Analyses`) ||
      (groups.size === 1 && analyses.length === 1 ? analyses[0] : null);
    return {
      id: g.key,
      slices: g.slices,
      analysis,
      dir: g.dir,
      patientName: personName(first.patientName),
      studyDate: formatDate(first.studyDate),
      count: frames,
    };
  });
  series.sort((a, b) => b.count - a.count);
  if (!series.length) throw firstError instanceof DicomError ? firstError : new DicomError('noImages');
  return series;
}

// Robust intensity range and maximum from a strided sample.
export function volumeStats(data: Uint16Array, nx: number, ny: number, nz: number) {
  const hist = new Uint32Array(65536);
  let count = 0;
  const nxy = nx * ny;
  for (let z = 0; z < nz; z += 4) {
    for (let y = 0; y < ny; y += 4) {
      let p = z * nxy + y * nx;
      for (let x = 0; x < nx; x += 4, p += 4) { hist[data[p]]++; count++; }
    }
  }
  let max = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
  const percentile = (q: number) => {
    const target = q * count;
    let acc = 0;
    for (let v = 0; v < 65536; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 65535;
  };
  return { max, percentiles: [percentile(0.01), percentile(0.998)] };
}

export async function loadSeries(series: Series, onProgress?: (fraction: number) => void): Promise<{ meta: ScanMeta; data: Uint16Array }> {
  const first = series.slices[0].info;
  const rows = first.rows, cols = first.cols;
  if ((first.samples ?? 1) !== 1) throw new DicomError('color');
  const bits = first.bits || 16;
  if (bits !== 8 && bits !== 16) throw new DicomError('bits', String(bits));
  const signed = first.signed === 1;
  const nxy = rows * cols;
  const frameBytes = nxy * (bits / 8);

  const orient = nums(first.orientation);
  const [a, b] = orient.length === 6 ? [orient.slice(0, 3), orient.slice(3)] : [[1, 0, 0], [0, 1, 0]];
  const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const along = (p: number[]) => p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2];
  const step = num(first.spacingBetween, 0) || num(first.sliceThickness, 0) || 1;

  const frames: { file: FileLike; offset: number; pos: number }[] = [];
  for (const s of series.slices) {
    if (s.info.rows !== rows || s.info.cols !== cols) throw new DicomError('sizes');
    const n = Math.max(1, num(s.info.frames, 1));
    if (s.info.pixelLength < n * frameBytes) throw new DicomError('truncated');
    for (let f = 0; f < n; f++) {
      const p = nums(n > 1 ? s.info.framePositions[f] : s.info.position);
      const pos = p.length === 3 ? along(p) : n > 1 ? f * step : num(s.info.instance, 0);
      frames.push({ file: s.file, offset: s.info.pixelOffset + f * frameBytes, pos });
    }
  }
  frames.sort((x, y) => x.pos - y.pos);

  const nz = frames.length;
  if (nxy * nz * 2 > LIMITS.volumeBytes) throw new DicomError('tooLarge', `${Math.round((nxy * nz * 2) / 1048576)} MB`);
  let data: Uint16Array;
  try {
    data = new Uint16Array(nxy * nz);
  } catch {
    throw new DicomError('tooLarge', `${Math.round((nxy * nz * 2) / 1048576)} MB`);
  }

  let done = 0;
  await pool(frames, 8, async (fr, i) => {
    const ab = await fr.file.slice(fr.offset, fr.offset + frameBytes).arrayBuffer();
    if (ab.byteLength < frameBytes) throw new DicomError('truncated');
    const base = i * nxy;
    if (bits === 8) data.set(new Uint8Array(ab), base);
    else if (signed) {
      const src = new Int16Array(ab);
      for (let k = 0; k < nxy; k++) data[base + k] = src[k] + 32768;
    } else data.set(new Uint16Array(ab), base);
    done++;
    if (onProgress && done % 4 === 0) onProgress(done / nz);
  });

  const diffs: number[] = [];
  for (let i = 1; i < nz; i++) diffs.push(frames[i].pos - frames[i - 1].pos);
  diffs.sort((x, y) => x - y);
  const sane = (v: number) => (Number.isFinite(v) && v > 0.005 && v < 20 ? v : 1);
  const dz = sane(diffs.length ? Math.abs(diffs[diffs.length >> 1]) : num(first.sliceThickness, 1));
  const spacing = nums(first.pixelSpacing).map(sane);
  const slope = num(first.slope, 1);
  let intercept = num(first.intercept, 0);
  if (signed) intercept -= 32768 * slope;
  const wc = nums(first.windowCenter)[0], ww = nums(first.windowWidth)[0];
  const stats = volumeStats(data, cols, rows, nz);

  const meta: ScanMeta = {
    dims: [cols, rows, nz],
    spacing: [spacing[1] ?? 1, spacing[0] ?? 1, dz],
    slope,
    intercept,
    window: wc !== undefined && ww !== undefined ? { center: wc, width: ww } : null,
    percentiles: stats.percentiles,
    max: stats.max,
    patientName: personName(first.patientName),
    patientId: first.patientId || '',
    birthDate: formatDate(first.birthDate),
    studyDate: formatDate(first.studyDate),
    model: first.model || '',
    manufacturer: first.manufacturer || '',
    kvp: first.kvp || '',
    comments: first.comments || '',
    analysis: series.analysis,
  };
  return { meta, data };
}

// CS 3D Imaging context file: arches, nerve canals and display defaults. Untrusted input:
// no DTDs or entities, and every coordinate must be a finite, bounded number.
export function parseAnalysis(text: string): Analysis | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  const doc = new DOMParser().parseFromString(text.replace(/\0+/g, '').trim(), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const q = (sel: string, root: ParentNode = doc) => root.querySelector(sel);
  const coord = (v: string | number | null | undefined) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) < 1e5 ? n : NaN; };
  const points = (el: Element): Point[] => {
    const pts = [...el.children].filter((c) => c.tagName === 'Point').slice(0, LIMITS.curvePoints)
      .map((p) => ['x', 'y', 'z'].map((k) => coord(p.getAttribute(k))));
    return pts.every((p) => p.every(Number.isFinite)) ? pts : [];
  };
  const label = (v: string | null | undefined) => String(v ?? '').slice(0, 120);

  const result: Analysis = {
    name: label(q('IToothContext > Header > Name')?.textContent),
    reference: label(q('IToothContext > Header > Reference')?.textContent?.trim()),
    arches: [], canals: [], lut: null, ortho: null,
  };

  const lut = q('VolumeContext > Lut2D');
  const center = coord(lut?.getAttribute('windowlevel')), width = coord(lut?.getAttribute('windowwidth'));
  if (Number.isFinite(center) && width > 0) result.lut = { center, width };
  const ortho = q('VolumeContext > OrthoPositions');
  const op = ortho ? ['x', 'y', 'z'].map((k) => coord(ortho.getAttribute(k) || 0)) : null;
  if (op && op.every(Number.isFinite)) result.ortho = op;

  const names: Record<string, string> = {};
  doc.querySelectorAll('GraphicObjects > MultiResamples > Resample').forEach((r) => {
    names[r.getAttribute('resampleUid') ?? ''] = label(r.getAttribute('name'));
  });

  doc.querySelectorAll('MultiResamplesTools > ResamplesTool').forEach((tool) => {
    [...tool.children].filter((c) => c.tagName === 'Resample').forEach((res) => {
      const surface = [...res.children].find((c) => c.tagName === 'CurveSurface');
      if (!surface) return;
      const pts = points(surface);
      if (pts.length < 2) return;
      if (result.arches.length >= LIMITS.curves) return;
      const id = label(res.getAttribute('id'));
      const type = label(tool.getAttribute('type')).replace(/^e_/, '');
      result.arches.push({ id, type, name: names[id] || type, points: pts });
    });
  });

  doc.querySelectorAll('GraphicObjects > Canals > Canal').forEach((canal) => {
    const pts = points(canal);
    if (pts.length < 2 || result.canals.length >= LIMITS.curves) return;
    const radius = coord(canal.getAttribute('radius') || 1);
    const channel = (k: string) => { const v = coord(canal.getAttribute(k) ?? 1); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; };
    result.canals.push({
      name: label(canal.getAttribute('name') || 'Canal'),
      radius: radius > 0 && radius < 20 ? radius : 1.25,
      color: ['R', 'G', 'B'].map(channel),
      points: pts,
    });
  });

  return result;
}

// Collect files from a drag-and-drop, descending into folders. Chrome cannot read dropped
// folders through webkitGetAsEntry on file:// pages, so File System Access handles go first.
export async function entriesFromDrop(dataTransfer: DataTransfer): Promise<Entry[]> {
  // Everything must be taken synchronously: the DataTransfer is emptied once the event returns.
  // getAsFileSystemHandle is Chromium's File System Access API, missing from TypeScript's DOM types.
  type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
  const items = [...dataTransfer.items].filter((it) => it.kind === 'file') as HandleItem[];
  const handles = items.map((it) => it.getAsFileSystemHandle?.()).filter((h) => h !== undefined);
  const roots = items.map((it) => it.webkitGetAsEntry?.()).filter((r) => r != null);
  const plain = [...dataTransfer.files];

  if (handles.length) {
    try {
      const out: Entry[] = [];
      const walk = async (h: FileSystemHandle, path: string) => {
        if (h.kind === 'file') out.push({ file: await (h as FileSystemFileHandle).getFile(), path });
        else for await (const child of (h as FileSystemDirectoryHandle).values()) await walk(child, `${path}/${child.name}`);
      };
      for (const h of await Promise.all(handles)) if (h) await walk(h, h.name);
      if (out.length) return out;
    } catch (err) {
      console.warn('File System Access drop failed', err);
    }
  }

  if (roots.length) {
    try {
      const out: Entry[] = [];
      const walk = async (entry: FileSystemEntry) => {
        if (entry.isFile) {
          const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
          out.push({ file, path: entry.fullPath.replace(/^\//, '') });
        } else if (entry.isDirectory) {
          const reader = (entry as FileSystemDirectoryEntry).createReader();
          for (;;) {
            const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const child of batch) await walk(child);
          }
        }
      };
      for (const r of roots) await walk(r);
      if (out.length) return out;
    } catch (err) {
      console.warn('Entry API drop failed', err);
    }
  }

  const files = plain.filter((f) => f.size > 0).map((file) => ({ file, path: file.name }));
  if (!files.length) throw new DicomError('dropFailed');
  return files;
}

export function entriesFromInput(fileList: FileList): Entry[] {
  return [...fileList].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}
