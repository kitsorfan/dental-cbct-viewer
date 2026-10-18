// In-browser DICOM loading: groups local files into series and assembles a uint16 volume.
// Handles single-frame series and multi-frame (enhanced) images, uncompressed little-endian,
// deflated, JPEG Lossless and RLE, and turns any slice orientation to the patient axes.

import { CodecError, decodeJpegLossless, decodeRle } from './codecs.ts';
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
  photometric?: string;
  frames?: string;
  rows?: number;
  cols?: number;
  pixelSpacing?: string;
  bits?: number;
  bitsStored?: number;
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
  // Compressed pixel data: fragments in items from pixelOffset on, length undefined.
  encapsulated: boolean;
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
  slices: { file: FileLike; info: ImageInfo; path?: string }[];
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
  // MONOCHROME1: the lowest values are meant to be shown white.
  inverted?: boolean;
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
// How much of a file is read for its header, in turn: most headers fit the first window, enhanced
// multi-frame headers with a group per frame need more, and only a damaged file needs it all.
const HEADER_WINDOWS = [64 * 1024, 1024 * 1024, 16 * 1024 * 1024];
const IMPLICIT_LE = '1.2.840.10008.1.2';
const EXPLICIT_LE = '1.2.840.10008.1.2.1';
const DEFLATED_LE = '1.2.840.10008.1.2.1.99';
const RLE = '1.2.840.10008.1.2.5';
const JPEG_LOSSLESS = new Set(['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70']);

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
  0x00280004: ['photometric', 'CS'],
  0x00280008: ['frames', 'IS'],
  0x00280010: ['rows', 'US'],
  0x00280011: ['cols', 'US'],
  0x00280030: ['pixelSpacing', 'DS'],
  0x00280100: ['bits', 'US'],
  0x00280101: ['bitsStored', 'US'],
  0x00280103: ['signed', 'US'],
  0x00281050: ['windowCenter', 'DS'],
  0x00281051: ['windowWidth', 'DS'],
  0x00281052: ['intercept', 'DS'],
  0x00281053: ['slope', 'DS'],
};

// Specific Character Set terms read by one browser decoder.
const CHARSETS: Record<string, string> = {
  'ISO_IR 192': 'utf-8', 'ISO_IR 100': 'windows-1252', 'ISO_IR 101': 'iso-8859-2', 'ISO_IR 109': 'iso-8859-3',
  'ISO_IR 110': 'iso-8859-4', 'ISO_IR 126': 'iso-8859-7', 'ISO_IR 127': 'iso-8859-6', 'ISO_IR 138': 'iso-8859-8',
  'ISO_IR 144': 'iso-8859-5', 'ISO_IR 148': 'windows-1254', 'ISO_IR 166': 'windows-874', 'ISO_IR 203': 'iso-8859-15',
  'ISO_IR 13': 'shift_jis', 'GB18030': 'gb18030', 'GBK': 'gbk',
};

// ISO 2022 code extensions (Japanese, Korean, simplified Chinese, mixed scripts): escape sequences
// switch what the 7-bit (G0) and 8-bit (G1) bytes mean. 'kana' is JIS X 0201 katakana.
const ESCAPES: Record<string, ['g0' | 'g1', string]> = {
  '(B': ['g0', 'ascii'], '(J': ['g0', 'ascii'], '$B': ['g0', 'jis0208'], '$@': ['g0', 'jis0208'], '$(D': ['g0', 'jis0212'],
  ')I': ['g1', 'kana'], '$)C': ['g1', 'euc-kr'], '$)A': ['g1', 'gb18030'],
  '-A': ['g1', 'windows-1252'], '-B': ['g1', 'iso-8859-2'], '-C': ['g1', 'iso-8859-3'], '-D': ['g1', 'iso-8859-4'],
  '-F': ['g1', 'iso-8859-7'], '-G': ['g1', 'iso-8859-6'], '-H': ['g1', 'iso-8859-8'], '-L': ['g1', 'iso-8859-5'],
  '-M': ['g1', 'windows-1254'], '-T': ['g1', 'windows-874'], '-b': ['g1', 'iso-8859-15'],
};
// The G1 set a first ISO 2022 term starts with.
const ISO2022_G1: Record<string, string> = {
  'ISO 2022 IR 100': 'windows-1252', 'ISO 2022 IR 101': 'iso-8859-2', 'ISO 2022 IR 109': 'iso-8859-3',
  'ISO 2022 IR 110': 'iso-8859-4', 'ISO 2022 IR 126': 'iso-8859-7', 'ISO 2022 IR 127': 'iso-8859-6',
  'ISO 2022 IR 138': 'iso-8859-8', 'ISO 2022 IR 144': 'iso-8859-5', 'ISO 2022 IR 148': 'windows-1254',
  'ISO 2022 IR 166': 'windows-874', 'ISO 2022 IR 203': 'iso-8859-15', 'ISO 2022 IR 13': 'kana',
  'ISO 2022 IR 149': 'euc-kr', 'ISO 2022 IR 58': 'gb18030',
};

const decoders = new Map<string, TextDecoder>();
function decoder(label: string) {
  let d = decoders.get(label);
  if (!d) decoders.set(label, d = new TextDecoder(label));
  return d;
}

// How text values are read under a Specific Character Set (0008,0005).
export function textDecoder(charset: string): (bytes: Uint8Array) => string {
  const terms = charset.split('\\').map((s) => s.trim());
  if (!terms.some((s) => s.startsWith('ISO 2022'))) {
    const d = decoder(CHARSETS[terms.find((s) => CHARSETS[s]) ?? ''] ?? 'windows-1252');
    return (bytes) => d.decode(bytes);
  }
  const first = ISO2022_G1[terms[0]] ?? null;
  // 7-bit bytes: ASCII, or JIS X 0208/0212 pairs, read as EUC-JP with the high bit set.
  const gl = (run: Uint8Array, set: string) => {
    if (set === 'ascii') return decoder('windows-1252').decode(run);
    const out: number[] = [];
    for (let i = 0; i < run.length; i++) {
      const b = run[i];
      if (b < 0x21 || b > 0x7e) { out.push(b); continue; }
      if (set === 'jis0212') out.push(0x8f);
      out.push(b | 0x80, (run[++i] ?? 0) | 0x80);
    }
    return decoder('euc-jp').decode(new Uint8Array(out));
  };
  const gr = (run: Uint8Array, set: string | null) => decoder(set === 'kana' ? 'shift_jis' : set ?? 'windows-1252').decode(run);
  return (bytes) => {
    let g0 = 'ascii', g1 = first, out = '';
    for (let i = 0; i < bytes.length;) {
      if (bytes[i] === 0x1b) {
        const seq = [3, 2].map((n) => String.fromCharCode(...bytes.subarray(i + 1, i + 1 + n))).find((s) => ESCAPES[s]);
        if (seq) {
          const [which, set] = ESCAPES[seq];
          if (which === 'g0') g0 = set; else g1 = set;
          i += 1 + seq.length;
        } else {
          i++;
        }
        continue;
      }
      const high = bytes[i] >= 0x80;
      let j = i;
      while (j < bytes.length && bytes[j] !== 0x1b && (bytes[j] >= 0x80) === high) j++;
      out += high ? gr(bytes.subarray(i, j), g1) : gl(bytes.subarray(i, j), g0);
      i = j;
    }
    return out;
  };
}

// Compressed transfer syntaxes the viewer cannot decode, named for the error message.
const COMPRESSED: Record<string, string> = {
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.4.201': 'HTJ2K Lossless',
  '1.2.840.10008.1.2.4.203': 'HTJ2K',
};

class NeedMore extends Error {}

// Parse everything up to the pixel data. Throws NeedMore if the buffer ends first.
// inflated: a deflated file whose dataset has already been inflated.
export function parseHeader(buffer: ArrayBuffer, inflated = false): DicomInfo {
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
  let decode = textDecoder('');
  // Top-level values win over the same values found inside functional groups.
  const top: Record<string, string | number> = {};
  const nested: Record<string, string | number> = {};
  const framePositions: string[] = [];
  let pixelOffset = -1, pixelLength = 0, encapsulated = false;

  interface Head { tag: number; vr: string | null; length: number; size: number }
  // implicit: inside an undefined-length UN element, whose contents are always implicit VR.
  interface Context { top?: boolean; skip?: boolean; frame?: number; seq?: number; implicit?: boolean }

  const head = (p: number, implicit = false): Head => {
    if (p + 8 > len) throw new NeedMore();
    const group = dv.getUint16(p, true), elem = dv.getUint16(p + 2, true);
    const tag = ((group << 16) | elem) >>> 0;
    if (group === 0xfffe) return { tag, vr: null, length: dv.getUint32(p + 4, true), size: 8 };
    if ((explicit && !implicit) || group === 0x0002) {
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

  const text = (p: number, n: number) => decode(u8.subarray(p, p + n)).replace(/[\0\s]+$/, '').replace(/^\s+/, '');

  const store = (h: Head, p: number, ctx: Context) => {
    const want = WANTED[h.tag];
    if (!want || ctx.skip) return;
    if (p + h.length > len) throw new NeedMore();
    const [key, vr] = want;
    const value = vr === 'US' ? (h.length >= 2 ? dv.getUint16(p, true) : 0) : text(p, h.length);
    if (ctx.top) {
      top[key] = value;
      if (key === 'charset' && typeof value === 'string') decode = textDecoder(value);
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
      const h = head(p, ctx.implicit);
      if (h.tag === ITEM_DELIM) return p + 8;
      if (ctx.top && h.tag === PIXEL_DATA) {
        if (h.length === UNDEF) {
          if (transfer !== RLE && !JPEG_LOSSLESS.has(transfer)) throw new DicomError('compressed', COMPRESSED[transfer] || transfer);
          encapsulated = true;
        }
        pixelOffset = p + h.size;
        pixelLength = h.length;
        return -1;
      }
      const value = p + h.size;
      if (h.vr === 'SQ' || h.length === UNDEF) {
        const implicit = ctx.implicit || h.vr === 'UN';
        const inner: Context = ctx.skip || !DESCEND.has(h.tag) ? { skip: true, implicit } : { frame: ctx.frame, seq: h.tag, implicit };
        p = sequence(value, h.length, inner);
        continue;
      }
      if (h.tag === 0x00020010) {
        // File meta is always explicit VR; the transfer syntax decides the dataset's encoding.
        transfer = text(value, h.length);
        if (transfer === '1.2.840.10008.1.2.2') throw new DicomError('bigEndian');
        if (transfer === DEFLATED_LE && !inflated) throw new DicomError('deflated');
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
      const h = head(p, ctx.implicit);
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
        const itemCtx = ctx.skip ? ctx : { frame: ctx.seq === PER_FRAME ? index : ctx.frame, implicit: ctx.implicit };
        p = walk(p, itemEnd, itemCtx);
      }
      index++;
    }
    depth--;
    return p;
  };

  walk(preamble ? 132 : 0, Infinity, { top: true });
  // WANTED decides each field's type: numbers for US, text for the rest.
  const out = { ...nested, ...top, framePositions, pixelOffset, pixelLength, transfer, encapsulated } as DicomInfo;

  const frames = num(out.frames, 1);
  if ((out.rows ?? 0) > LIMITS.dimension || (out.cols ?? 0) > LIMITS.dimension || frames > LIMITS.frames || frames < 1) {
    throw new DicomError('dims', `${out.cols}×${out.rows}×${frames}`);
  }
  return out;
}

// A file's header, and the file to read its pixels from: a deflated file is replaced by its
// inflated copy.
async function readHeader(file: FileLike): Promise<{ info: DicomInfo; file: FileLike }> {
  const attempt = async (blob: Readable) => {
    try {
      return parseHeader(await blob.arrayBuffer());
    } catch (err) {
      if (err instanceof DicomError) throw err;
      if (!(err instanceof NeedMore)) throw new DicomError('invalid'); // malformed lengths or offsets
      return null;
    }
  };
  try {
    for (const size of HEADER_WINDOWS) {
      if (file.size <= size) break;
      const info = await attempt(file.slice(0, size));
      if (info) return { info, file };
    }
    const info = await attempt(file);
    if (!info) throw new DicomError('noPixels');
    return { info, file };
  } catch (err) {
    if (err instanceof DicomError && err.code === 'deflated') return inflateDataset(file);
    throw err;
  }
}

// Deflated explicit VR little endian: everything after the file meta group is one deflate stream.
async function inflateDataset(file: FileLike): Promise<{ info: DicomInfo; file: FileLike }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 132;
  while (p + 8 <= bytes.length && dv.getUint16(p, true) === 0x0002) {
    const long = LONG_VRS.has(String.fromCharCode(bytes[p + 4], bytes[p + 5]));
    p += long ? 12 + (p + 12 <= bytes.length ? dv.getUint32(p + 8, true) : 0) : 8 + dv.getUint16(p + 6, true);
  }
  if (p > bytes.length) throw new DicomError('invalid');
  const chunks: Uint8Array<ArrayBuffer>[] = [bytes.subarray(0, p)];
  let total = 0;
  try {
    const reader = new Blob([bytes.subarray(p)]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > LIMITS.volumeBytes) {
        reader.cancel().catch(() => {});
        throw new DicomError('tooLarge', `${Math.round(total / 1048576)} MB`);
      }
      chunks.push(value);
    }
  } catch (err) {
    throw err instanceof DicomError ? err : new DicomError('invalid');
  }
  const inflated = new Blob(chunks);
  try {
    return { info: parseHeader(await inflated.arrayBuffer(), true), file: inflated };
  } catch (err) {
    throw err instanceof DicomError ? err : new DicomError(err instanceof NeedMore ? 'noPixels' : 'invalid');
  }
}

const nums = (s: string | number | undefined) => (s ? String(s).split('\\').map(Number).filter((v) => !Number.isNaN(v)) : []);
const num = (s: string | number | undefined, d: number) => { const v = nums(s)[0]; return v === undefined ? d : v; };

// Family and given name. Alphabetic, ideographic and phonetic forms are separated by '=';
// the first one present is shown.
export function personName(s: string | undefined) {
  if (!s) return '';
  const group = s.split('=').find((g) => g.replace(/\^/g, '').trim()) ?? '';
  return group.split('^').map((p) => p.trim()).filter(Boolean).slice(0, 2).join(' ');
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
  const named = (e: Entry) => lower(e).endsWith('.dcm') || lower(e).endsWith('.dicom');
  // Files without the extension are checked too: a CD can hold its volume as DICOM/IM* files
  // next to a single .dcm (a 2D image or a sample) that must not hide it.
  const others = entries.filter((e) => !named(e) && !/\.(xml|txt|exe|dll|ini|html?|jpe?g|png|pdf|zip|js|css|json)$/i.test(e.path)
    && !/(^|\/)dicomdir$/i.test(e.path));
  const flags: boolean[] = [];
  await pool(others, 16, async (e, i) => { flags[i] = await hasDicomMagic(e.file); });
  const candidates = [...entries.filter(named), ...others.filter((_, i) => flags[i])];

  interface Group { key: string; dir: string; uid: string; slices: Series['slices'] }
  const groups = new Map<string, Group>();
  let done = 0;
  let firstError: unknown = null;
  await pool(candidates, 16, async (e) => {
    try {
      const { info, file } = await readHeader(e.file);
      if (hasImage(info)) {
        const key = `${info.seriesUid || ''}|${dirOf(e.path)}`;
        let group = groups.get(key);
        if (!group) groups.set(key, group = { key, dir: dirOf(e.path), uid: info.seriesUid || '', slices: [] });
        group.slices.push({ file, info, path: e.path });
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

// Encapsulated pixel data: an offset table item, then fragments up to the sequence delimiter.
// Returns each frame's compressed bytes.
async function encapsulatedFrames(file: FileLike, offset: number, frames: number): Promise<Uint8Array[]> {
  const bytes = new Uint8Array(await file.slice(offset, file.size).arrayBuffer());
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const items: { at: number; start: number; end: number }[] = [];
  for (let p = 0; p + 8 <= bytes.length;) {
    const group = dv.getUint16(p, true), elem = dv.getUint16(p + 2, true), length = dv.getUint32(p + 4, true);
    if (group !== 0xfffe || (elem !== 0xe000 && elem !== 0xe0dd)) throw new DicomError('invalid');
    if (elem === 0xe0dd) break;
    if (p + 8 + length > bytes.length) throw new DicomError('truncated');
    items.push({ at: p, start: p + 8, end: p + 8 + length });
    p += 8 + length;
  }
  const [table, ...fragments] = items;
  if (!fragments.length) throw new DicomError('truncated');

  // Which fragments make up each frame: the offset table says, or one fragment per frame,
  // or for JPEG each frame starts with its own start-of-image marker.
  let groups: (typeof fragments)[] = [];
  const offsets: number[] = [];
  for (let p = table.start; p + 4 <= table.end; p += 4) offsets.push(dv.getUint32(p, true));
  const ascending = offsets.every((o, i) => (i ? o > offsets[i - 1] : o === 0));
  if (frames === 1) {
    groups = [fragments];
  } else if (offsets.length === frames && ascending) {
    groups = offsets.map(() => []);
    let f = 0;
    for (const fr of fragments) {
      while (f + 1 < frames && fr.at - fragments[0].at >= offsets[f + 1]) f++;
      groups[f].push(fr);
    }
  } else if (fragments.length === frames) {
    groups = fragments.map((fr) => [fr]);
  } else {
    for (const fr of fragments) {
      if (!groups.length || (bytes[fr.start] === 0xff && bytes[fr.start + 1] === 0xd8)) groups.push([]);
      groups[groups.length - 1].push(fr);
    }
  }
  if (groups.length !== frames || groups.some((g) => !g.length)) throw new DicomError('invalid');
  return groups.map((g) => {
    if (g.length === 1) return bytes.subarray(g[0].start, g[0].end);
    const out = new Uint8Array(g.reduce((n, fr) => n + fr.end - fr.start, 0));
    let o = 0;
    for (const fr of g) { out.set(bytes.subarray(fr.start, fr.end), o); o += fr.end - fr.start; }
    return out;
  });
}

// One compressed frame as little-endian samples, like an uncompressed one.
function decodeFrame(bytes: Uint8Array, transfer: string, rows: number, cols: number, bits: number): ArrayBuffer {
  let px: Uint8Array | Uint16Array;
  try {
    if (transfer === RLE) {
      px = decodeRle(bytes, rows, cols, bits);
    } else {
      const image = decodeJpegLossless(bytes);
      if (image.width !== cols || image.height !== rows) throw new DicomError('invalid');
      px = bits === 8 ? Uint8Array.from(image.pixels) : image.pixels;
    }
  } catch (err) {
    if (err instanceof CodecError) throw new DicomError(err.code, err.detail ?? '');
    throw err;
  }
  return px.byteOffset === 0 && px.byteLength === px.buffer.byteLength ? px.buffer as ArrayBuffer : px.slice().buffer;
}

// Stored axes to patient axes. Each stored axis (columns, rows, slices) runs along the patient
// axis closest to its direction: x to the patient's left, y posterior, z superior. Returns null
// when the scan is already stored that way, or too oblique to tell.
export function toPatientAxes(dims: number[], directions: number[][]) {
  const along = directions.map((d) => {
    const size = d.map(Math.abs);
    const k = size.indexOf(Math.max(...size));
    return { k, flip: d[k] < 0 };
  });
  if (along.every((a, i) => a.k === i && !a.flip) || new Set(along.map((a) => a.k)).size < 3) return null;
  const out = [0, 0, 0];
  along.forEach((a, i) => { out[a.k] = dims[i]; });
  // Where a stored point lands, in voxels.
  const point = (p: number[]) => {
    const q = [0, 0, 0];
    along.forEach((a, i) => { q[a.k] = a.flip ? dims[i] - 1 - p[i] : p[i]; });
    return [...q, ...p.slice(3)];
  };
  const reorder = <T>(v: T[]) => { const q = v.slice(); along.forEach((a, i) => { q[a.k] = v[i]; }); return q; };
  const transform = (data: Uint16Array) => {
    let moved: Uint16Array;
    try {
      moved = new Uint16Array(data.length);
    } catch {
      throw new DicomError('tooLarge', `${Math.round((data.length * 2) / 1048576)} MB`);
    }
    const strides = [1, out[0], out[0] * out[1]];
    const step = along.map((a) => (a.flip ? -strides[a.k] : strides[a.k]));
    const start = along.reduce((s, a, i) => s + (a.flip ? (dims[i] - 1) * strides[a.k] : 0), 0);
    let p = 0;
    for (let k = 0; k < dims[2]; k++) {
      for (let j = 0; j < dims[1]; j++) {
        let o = start + k * step[2] + j * step[1];
        for (let i = 0; i < dims[0]; i++, o += step[0]) moved[o] = data[p++];
      }
    }
    return moved;
  };
  return { dims: out, point, reorder, transform };
}

export async function loadSeries(series: Series, onProgress?: (fraction: number) => void): Promise<{ meta: ScanMeta; data: Uint16Array }> {
  const first = series.slices[0].info;
  const rows = first.rows, cols = first.cols;
  if ((first.samples ?? 1) !== 1) throw new DicomError('color');
  const bits = first.bits || 16;
  if (bits !== 8 && bits !== 16) throw new DicomError('bits', String(bits));
  const signed = first.signed === 1;
  const stored = Math.min(bits, Math.max(1, first.bitsStored || bits));
  const nxy = rows * cols;
  const frameBytes = nxy * (bits / 8);

  const orient = nums(first.orientation);
  const [a, b] = orient.length === 6 ? [orient.slice(0, 3), orient.slice(3)] : [[1, 0, 0], [0, 1, 0]];
  const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const along = (p: number[]) => p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2];
  const step = num(first.spacingBetween, 0) || num(first.sliceThickness, 0) || 1;
  // Slices without a position go by Instance Number, or failing that by file name.
  const byName = [...series.slices].sort((x, y) => (x.path ?? '').localeCompare(y.path ?? '', 'en', { numeric: true }));
  const nameOrder = new Map(byName.map((s, i) => [s, i]));

  // Compressed frames come from their file's fragments, read once per file.
  const fragments = new Map<FileLike, Promise<Uint8Array[]>>();
  const compressed = (s: Series['slices'][number], f: number, n: number) => async () => {
    let list = fragments.get(s.file);
    if (!list) fragments.set(s.file, list = encapsulatedFrames(s.file, s.info.pixelOffset, n));
    return decodeFrame((await list)[f], s.info.transfer, rows, cols, bits);
  };

  const frames: { read: () => Promise<ArrayBuffer>; pos: number }[] = [];
  for (const s of series.slices) {
    if (s.info.rows !== rows || s.info.cols !== cols) throw new DicomError('sizes');
    const n = Math.max(1, num(s.info.frames, 1));
    if (!s.info.encapsulated && s.info.pixelLength < n * frameBytes) throw new DicomError('truncated');
    for (let f = 0; f < n; f++) {
      const p = nums(n > 1 ? s.info.framePositions[f] : s.info.position);
      const pos = p.length === 3 ? along(p) : n > 1 ? f * step : (nums(s.info.instance)[0] ?? nameOrder.get(s) ?? 0) * step;
      const offset = s.info.pixelOffset + f * frameBytes;
      const read = s.info.encapsulated ? compressed(s, f, n) : () => s.file.slice(offset, offset + frameBytes).arrayBuffer();
      frames.push({ read, pos });
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

  // Signed values are moved up by 32768 (the intercept takes it back off) and sign-extended from
  // Bits Stored, since some files leave the bits above it clear. Unsigned values are kept as they
  // are: some scanners store values above Bits Stored, and masking would wrap them.
  const mask = 2 ** stored - 1, sign = 2 ** (stored - 1);
  let done = 0;
  await pool(frames, 8, async (fr, i) => {
    const ab = await fr.read();
    if (ab.byteLength < frameBytes) throw new DicomError('truncated');
    const base = i * nxy;
    const src = bits === 8 ? new Uint8Array(ab, 0, nxy) : new Uint16Array(ab, 0, nxy);
    if (!signed) data.set(src, base);
    else for (let k = 0; k < nxy; k++) { const v = src[k] & mask; data[base + k] = (v & sign ? v - mask - 1 : v) + 32768; }
    done++;
    if (onProgress && done % 4 === 0) onProgress(done / nz);
  });

  const diffs: number[] = [];
  for (let i = 1; i < nz; i++) diffs.push(frames[i].pos - frames[i - 1].pos);
  diffs.sort((x, y) => x - y);
  const sane = (v: number) => (Number.isFinite(v) && v > 0.005 && v < 20 ? v : 1);
  const dz = sane(diffs.length ? Math.abs(diffs[diffs.length >> 1]) : num(first.sliceThickness, 1));
  const pixelSpacing = nums(first.pixelSpacing).map(sane);
  const slope = num(first.slope, 1);
  let intercept = num(first.intercept, 0);
  if (signed) intercept -= 32768 * slope;
  const wc = nums(first.windowCenter)[0], ww = nums(first.windowWidth)[0];

  let dims = [cols, rows, nz];
  let spacing = [pixelSpacing[1] ?? 1, pixelSpacing[0] ?? 1, dz];
  let analysis = series.analysis;
  const turn = toPatientAxes(dims, [a, b, normal]);
  if (turn) {
    data = turn.transform(data);
    dims = turn.dims;
    spacing = turn.reorder(spacing);
    if (analysis) {
      const pts = (list: Point[]) => list.map(turn.point);
      analysis = {
        ...analysis,
        arches: analysis.arches.map((arch) => ({ ...arch, points: pts(arch.points) })),
        canals: analysis.canals.map((c) => ({ ...c, points: pts(c.points) })),
        ortho: analysis.ortho && turn.point(analysis.ortho),
      };
    }
  }
  const stats = volumeStats(data, dims[0], dims[1], dims[2]);

  const meta: ScanMeta = {
    dims: [dims[0], dims[1], dims[2]],
    spacing: [spacing[0], spacing[1], spacing[2]],
    slope,
    intercept,
    window: wc !== undefined && ww !== undefined ? { center: wc, width: ww } : null,
    percentiles: stats.percentiles,
    max: stats.max,
    inverted: first.photometric === 'MONOCHROME1',
    patientName: personName(first.patientName),
    patientId: first.patientId || '',
    birthDate: formatDate(first.birthDate),
    studyDate: formatDate(first.studyDate),
    model: first.model || '',
    manufacturer: first.manufacturer || '',
    kvp: first.kvp || '',
    comments: first.comments || '',
    analysis,
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
