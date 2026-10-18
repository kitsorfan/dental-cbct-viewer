// Decoders for the compressed pixel data scanners commonly export, grayscale only: lossless
// JPEG (ITU T.81 process 14; transfer syntaxes .4.57 and .4.70) and RLE Lossless (PS3.5
// Annex G). Files are untrusted: every read is bounds-checked, every loop is bounded by the
// image size, nothing is allocated beyond what the input could encode, and damaged data fails
// with a CodecError, which the DICOM layer translates into its own errors.

export class CodecError extends Error {
  code: string;
  detail?: string;

  constructor(code: 'invalid' | 'compressed', detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

const MAX_SAMPLES = 64 * 1024 * 1024;
const invalid = () => new CodecError('invalid');

// The next FAST bits of the stream are looked up directly: usually they hold a whole
// difference, code and extra bits; otherwise at least its code. Longer codes go by length.
const FAST = 12;

interface Huffman {
  whole: Int32Array; // the next FAST bits -> difference << 5 | bits used, or 0
  fast: Uint16Array; // the next FAST bits -> code length << 8 | category, or 0 for a longer code
  max: Int32Array; // largest code of each length, -1 if there is none
  off: Int32Array; // index in vals of the codes of each length, minus the first such code
  vals: Uint8Array;
}

// F.12 EXTEND: z extra bits with a leading 0 stand for a negative difference.
const extend = (v: number, z: number) => (v < 1 << (z - 1) ? v - (1 << z) + 1 : v);

// Annex C: codes go to the values in order of length, counting up within a length and
// doubling to move to the next.
function huffman(counts: Uint8Array, vals: Uint8Array): Huffman {
  const fast = new Uint16Array(1 << FAST), max = new Int32Array(17).fill(-1), off = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    const c = counts[l - 1];
    if (code + c > 1 << l) throw invalid(); // more codes than l bits can hold
    off[l] = k - code;
    if (c) max[l] = code + c - 1;
    for (const end = k + c; k < end; k++, code++) {
      if (vals[k] > 16) throw invalid(); // lossless differences fall in categories 0–16 (Table H.2)
      if (l <= FAST) fast.fill((l << 8) | vals[k], code << (FAST - l), (code + 1) << (FAST - l));
    }
    code <<= 1;
  }
  const whole = new Int32Array(1 << FAST);
  for (let i = 0; i < 1 << FAST; i++) {
    const l = fast[i] >> 8, z = fast[i] & 0xff, used = l + (z < 16 ? z : 0);
    if (!l || used > FAST) continue;
    const v = z === 16 ? 32768 : z ? extend((i >> (FAST - used)) & ((1 << z) - 1), z) : 0;
    whole[i] = (v << 5) | used;
  }
  return { whole, fast, max, off, vals };
}

// A code longer than FAST bits, given the next 16 bits of the stream; 0 if none matches.
function slowCode(t: Huffman, bits: number) {
  for (let l = FAST + 1; l <= 16; l++) {
    const c = bits >>> (16 - l);
    if (c <= t.max[l]) return (l << 8) | t.vals[c + t.off[l]];
  }
  return 0;
}

// The entropy-coded data of one restart interval, unstuffed, as u[q..end), plus n bits read
// ahead into buf. Reading past the end yields zeros, so a damaged stream cannot run away;
// overrun() tells afterwards whether any of them were used.
interface Bits { u: Uint8Array; q: number; end: number; buf: number; n: number }

const overrun = (s: Bits) => s.n < 8 * (s.q - s.end);

// k differences into d: a Huffman-coded category, then that many extra bits (F.1.2.1).
// Category 16 is 32768 with no extra bits.
function differences(s: Bits, t: Huffman, d: Int32Array, k: number) {
  const { u, end } = s, { whole, fast } = t;
  let { q, buf, n } = s;
  for (let j = 0; j < k; j++) {
    while (n < 25) { buf = (buf << 8) | (q < end ? u[q] : 0); q++; n += 8; }
    const look = (buf >>> (n - FAST)) & ((1 << FAST) - 1), hit = whole[look];
    if (hit) {
      n -= hit & 31;
      d[j] = hit >> 5;
      continue;
    }
    let e = fast[look];
    if (!e && !(e = slowCode(t, (buf >>> (n - 16)) & 0xffff))) throw invalid();
    n -= e >> 8;
    const z = e & 0xff;
    let v = 0;
    if (z === 16) {
      v = 32768;
    } else if (z) {
      while (n < z) { buf = (buf << 8) | (q < end ? u[q] : 0); q++; n += 8; }
      v = extend((buf >>> (n - z)) & ((1 << z) - 1), z);
      n -= z;
    }
    d[j] = v;
  }
  s.q = q;
  s.buf = buf;
  s.n = n;
}

// Samples i..stop-1, a line from its start, after the first line of their restart interval: the
// first is predicted from the sample above, the rest by the scan's predictor (Table H.1).
// Arithmetic is modulo 2^16, then cut to the sample precision.
function predict(out: Uint16Array, d: Int32Array, i: number, stop: number, w: number, predictor: number, mask: number) {
  out[i] = (out[i - w] + d[0]) & mask;
  let j = 1;
  switch (predictor) {
    case 1: for (; ++i < stop; j++) out[i] = (out[i - 1] + d[j]) & mask; break;
    case 2: for (; ++i < stop; j++) out[i] = (out[i - w] + d[j]) & mask; break;
    case 3: for (; ++i < stop; j++) out[i] = (out[i - w - 1] + d[j]) & mask; break;
    case 4: for (; ++i < stop; j++) out[i] = (out[i - 1] + out[i - w] - out[i - w - 1] + d[j]) & mask; break;
    case 5: for (; ++i < stop; j++) out[i] = (out[i - 1] + ((out[i - w] - out[i - w - 1]) >> 1) + d[j]) & mask; break;
    case 6: for (; ++i < stop; j++) out[i] = (out[i - w] + ((out[i - 1] - out[i - w - 1]) >> 1) + d[j]) & mask; break;
    case 7: for (; ++i < stop; j++) out[i] = (((out[i - 1] + out[i - w]) >> 1) + d[j]) & mask; break;
  }
}

interface Frame { width: number; height: number; precision: number }

// The scan whose entropy-coded data starts at p: unstuffed and split at its restart markers
// first, then rebuilt line by line.
function scan(data: Uint8Array, p: number, frame: Frame, t: Huffman, predictor: number, pt: number, ri: number) {
  const { width: w, height: h, precision } = frame, len = data.length;
  const u = new Uint8Array(len - p), marks: number[] = [];
  let o = 0;
  while (p < len) {
    let f = data.indexOf(0xff, p);
    if (f < 0) f = len;
    u.set(data.subarray(p, f), o);
    o += f - p;
    for (p = f + 1; p < len && data[p] === 0xff;) p++; // fill bytes before a marker
    if (p >= len) break;
    const m = data[p++];
    if (m === 0) {
      u[o++] = 0xff;
    } else if (m >> 3 === 0x1a) { // RST0–7, numbered in sequence
      if ((m & 7) !== (marks.length & 7)) throw invalid();
      marks.push(o);
    } else {
      break;
    }
  }
  const n = w * h;
  if (o * 8 < n) throw invalid(); // every sample takes at least a bit

  const out = new Uint16Array(n), d = new Int32Array(w);
  const mask = (1 << (precision - pt)) - 1, init = 1 << (precision - pt - 1);
  const bits: Bits = { u, q: 0, end: marks.length ? marks[0] : o, buf: 0, n: 0 };
  let todo = ri || n, interval = 0;
  for (let row = 0; row < n; row += w) {
    // A line is cut where a restart interval ends; only the first piece may be a continuation.
    for (let x = 0; x < w;) {
      let fresh = row + x === 0;
      if (!todo) {
        if (overrun(bits) || ++interval > marks.length) throw invalid();
        bits.q = marks[interval - 1];
        bits.end = interval < marks.length ? marks[interval] : o;
        bits.buf = bits.n = 0;
        todo = ri;
        fresh = true;
      }
      const k = Math.min(w - x, todo);
      todo -= k;
      differences(bits, t, d, k);
      let i = row + x;
      const stop = i + k;
      if (fresh) {
        // An interval starts from the middle value; the rest of its first line from the left.
        out[i] = (init + d[0]) & mask;
        for (let j = 1; ++i < stop; j++) out[i] = (out[i - 1] + d[j]) & mask;
      } else {
        predict(out, d, i, stop, w, predictor, mask);
      }
      x += k;
    }
  }
  if (overrun(bits)) throw invalid();
  if (pt) for (let i = 0; i < n; i++) out[i] <<= pt;
  return out;
}

const PROCESS = ['Baseline', 'Extended', 'Progressive', 'Lossless'];

// One grayscale lossless JPEG (SOF3, Huffman coded) with every predictor, point transform and
// restart intervals. Samples come back as the raw unsigned P-bit values.
export function decodeJpegLossless(data: Uint8Array): { width: number; height: number; precision: number; pixels: Uint16Array } {
  const len = data.length;
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
  const tables: [counts: Uint8Array, vals: Uint8Array][] = [];
  let frame: Frame | null = null, ri = 0;
  if (len < 2 || data[0] !== 0xff || data[1] !== 0xd8) throw invalid();
  for (let p = 2; ;) {
    // Markers may be preceded by fill bytes; stray bytes between segments are skipped, as libjpeg does.
    while (p < len && data[p] !== 0xff) p++;
    while (p < len && data[p] === 0xff) p++;
    if (p >= len) throw invalid();
    const m = data[p++];
    if (m <= 1 || m >> 3 === 0x1a) continue; // markers without a segment
    if (m === 0xd8 || m === 0xd9 || p + 2 > len) throw invalid();
    const s = p + 2, end = p + u16(p);
    if (end < s || end > len) throw invalid();
    if (m === 0xc3) {
      if (frame || end - s < 6) throw invalid();
      const precision = data[s], height = u16(s + 1), width = u16(s + 3), nf = data[s + 5];
      if (nf > 1) throw new CodecError('compressed', `JPEG Lossless, ${nf} components`);
      if (!nf || precision < 2 || precision > 16 || !width) throw invalid();
      if (!height) throw new CodecError('compressed', 'JPEG Lossless with DNL');
      if (width * height > MAX_SAMPLES) throw invalid();
      frame = { width, height, precision };
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new CodecError('compressed', `JPEG ${PROCESS[m & 3]}${m & 4 ? ' hierarchical' : ''}${m & 8 ? ' arithmetic' : ''}`);
    } else if (m === 0xc4) {
      for (let q = s; q < end;) {
        const tc = data[q] >> 4, th = data[q] & 15, v = q + 17;
        if (tc > 1 || th > 3 || v > end) throw invalid();
        let total = 0;
        for (let i = q + 1; i < v; i++) total += data[i];
        if (v + total > end) throw invalid();
        if (!tc) tables[th] = [data.subarray(q + 1, v), data.subarray(v, v + total)]; // AC tables go unused
        q = v + total;
      }
    } else if (m === 0xdd) {
      if (end - s < 2) throw invalid();
      ri = u16(s);
    } else if (m === 0xda) {
      // One component means one scan: Ns 1, table Td, predictor Ss, point transform Al.
      if (!frame || end - s < 6 || data[s] !== 1) throw invalid();
      // Only the table in use is built: a file can define thousands.
      const table = tables[data[s + 2] >> 4], predictor = data[s + 3], pt = data[s + 5] & 15;
      if (!table || predictor < 1 || predictor > 7 || pt >= frame.precision) throw invalid();
      return { ...frame, pixels: scan(data, end, frame, huffman(...table), predictor, pt, ri) };
    }
    p = end;
  }
}

// PackBits: a header byte h below 128 copies the next h + 1 bytes, one above repeats the next
// byte 257 - h times, and 128 does nothing. Stops after n bytes, ignoring any padding.
function unpack(src: Uint8Array, p: number, end: number, n: number) {
  const out = new Uint8Array(n);
  for (let o = 0; o < n;) {
    if (p >= end) throw invalid();
    const h = src[p++];
    if (h < 128) {
      const stop = o + Math.min(h + 1, n - o);
      if (p + stop - o > end) throw invalid();
      for (let q = p; o < stop;) out[o++] = src[q++];
      p += h + 1;
    } else if (h > 128) {
      if (p >= end) throw invalid();
      const b = src[p++], stop = o + Math.min(257 - h, n - o);
      while (o < stop) out[o++] = b;
    }
  }
  return out;
}

// RLE Lossless: a 64-byte header with the segment count and up to 15 offsets, then a PackBits
// segment per byte of the sample, most significant first. 16-bit samples come back composed.
export function decodeRle(data: Uint8Array, rows: number, cols: number, bitsAllocated: number): Uint8Array | Uint16Array {
  if (bitsAllocated !== 8 && bitsAllocated !== 16) throw new CodecError('compressed', `RLE ${bitsAllocated}-bit`);
  const bytes = bitsAllocated >> 3, n = rows * cols;
  if (!(rows > 0 && cols > 0 && Number.isInteger(n) && n <= MAX_SAMPLES) || data.length < 64) throw invalid();
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = dv.getUint32(0, true);
  if (count === 3 * bytes) throw new CodecError('compressed', 'RLE color');
  if (count !== bytes) throw invalid();
  const planes: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const start = dv.getUint32(4 + 4 * i, true);
    const end = i + 1 < count ? dv.getUint32(8 + 4 * i, true) : data.length;
    // A segment cannot expand more than 64-fold (2 bytes repeat one up to 128 times).
    if (start < 64 || end > data.length || (end - start) * 64 < n) throw invalid();
    planes.push(unpack(data, start, end, n));
  }
  if (bytes === 1) return planes[0];
  const [hi, lo] = planes, out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = (hi[i] << 8) | lo[i];
  return out;
}
