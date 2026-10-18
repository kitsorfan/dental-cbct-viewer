// Builds lossless JPEG streams (ITU T.81 process 14, one component) and RLE Lossless frames in
// memory for the codec tests. Written straight from the standards, sample by sample, rather
// than from the decoder: prediction H.1.2.1 and Table H.1, difference categories Table H.2,
// extra bits F.1.2.1, code assignment Annex C, padding and stuffing F.1.2.3 and B.1.1.5.

// bits[i] counts the codes of length i + 1; values lists the categories in code order.
export interface HuffmanSpec { bits: number[]; values: number[] }

// Table K.3 (the standard luminance DC table) extended to the lossless categories 12–16,
// so codes run from 2 to 14 bits and none is all ones.
export const STANDARD: HuffmanSpec = {
  bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
  values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
};

// Small differences get the longest codes (15 and 16 bits), so most lookups miss a short table.
export const DEEP: HuffmanSpec = {
  bits: [0, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
  values: [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
};

// A complete code from 1 to 16 bits: category 16 gets the all-ones 16-bit code.
export const COMPLETE: HuffmanSpec = {
  bits: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
  values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
};

export interface JpegOptions {
  precision: number;
  predictor?: number; // selection value Ss, 1–7
  pt?: number; // point transform Al
  restart?: number; // restart interval in samples; 0 for none
  table?: HuffmanSpec;
  tableId?: number; // the Td the scan selects
  others?: { id: number; spec: HuffmanSpec }[]; // more tables, in the same DHT segment before the scan's
  fill?: boolean; // fill bytes before each RST marker
  before?: Uint8Array[]; // segments placed between SOI and the frame header
}

// A marker segment: FF, the marker, a length that counts itself, the payload.
export function segment(marker: number, payload: number[] | Uint8Array) {
  const n = payload.length + 2;
  return Uint8Array.from([0xff, marker, n >> 8, n & 0xff, ...payload]);
}

export function dhtSegment(tables: { id: number; spec: HuffmanSpec }[]) {
  return segment(0xc4, tables.flatMap(({ id, spec }) => [id, ...spec.bits, ...spec.values]));
}

// Figures C.1–C.3: sizes in table order, codes counting up and shifting left when the size
// grows, then reordered by value.
function codeTable(spec: HuffmanSpec) {
  const sizes = spec.bits.flatMap((count, i) => Array<number>(count).fill(i + 1));
  const code: number[] = [], size: number[] = [];
  let c = 0, si = sizes[0];
  for (let k = 0; k < sizes.length;) {
    while (sizes[k] === si) {
      code[spec.values[k]] = c++;
      size[spec.values[k]] = si;
      k++;
    }
    c <<= 1;
    si++;
  }
  return { code, size };
}

class BitWriter {
  bytes: number[] = [];
  acc = 0;
  n = 0;

  put(value: number, size: number) {
    for (let i = size - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      if (++this.n < 8) continue;
      this.bytes.push(this.acc);
      if (this.acc === 0xff) this.bytes.push(0); // byte stuffing
      this.acc = this.n = 0;
    }
  }

  // Pad the last byte with 1-bits.
  flush() {
    while (this.n) this.put(1, 1);
  }
}

// pixels: P-bit samples in raster order.
export function writeJpegLossless(pixels: ArrayLike<number>, width: number, height: number, opts: JpegOptions) {
  const { precision: P, predictor = 1, pt = 0, restart = 0, fill = false, before = [] } = opts;
  const { table = STANDARD, tableId = 0, others = [] } = opts;
  const { code, size } = codeTable(table);
  const s = Array.from(pixels, (v) => v >> pt); // the point transform divides by 2^Pt
  const w = new BitWriter();
  let rst = 0;
  for (let i = 0; i < s.length; i++) {
    if (restart && i > 0 && i % restart === 0) {
      w.flush();
      if (fill) w.bytes.push(0xff, 0xff);
      w.bytes.push(0xff, 0xd0 + (rst++ % 8));
    }
    const x = i % width, y = (i - x) / width;
    const start = restart ? i - (i % restart) : 0; // first sample of this restart interval
    const a = s[i - 1], b = s[i - width], c = s[i - width - 1];
    let px: number;
    if (i === start) px = 1 << (P - pt - 1);
    else if (y === Math.floor(start / width)) px = a; // first line of the scan or of the interval
    else if (x === 0) px = b;
    else px = [NaN, a, b, c, a + b - c, a + ((b - c) >> 1), b + ((a - c) >> 1), (a + b) >> 1][predictor];
    // The difference modulo 2^16, as -32767..32768.
    let diff = (s[i] - px) & 0xffff;
    if (diff > 32768) diff -= 65536;
    const ssss = diff === 32768 ? 16 : diff === 0 ? 0 : 32 - Math.clz32(Math.abs(diff));
    if (size[ssss] === undefined) throw new Error(`no code for category ${ssss}`);
    w.put(code[ssss], size[ssss]);
    // Negative differences send the low bits of diff - 1. Category 16 sends none.
    if (ssss && ssss < 16) w.put(diff < 0 ? diff - 1 : diff, ssss);
  }
  w.flush();

  const parts = [
    Uint8Array.of(0xff, 0xd8),
    ...before,
    segment(0xc3, [P, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]),
    dhtSegment([...others, { id: tableId, spec: table }]),
    ...(restart ? [segment(0xdd, [restart >> 8, restart & 0xff])] : []),
    segment(0xda, [1, 1, tableId << 4, predictor, 0, pt]),
    Uint8Array.from(w.bytes),
    Uint8Array.of(0xff, 0xd9),
  ];
  return concat(parts);
}

export function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// PackBits (PS3.5 G.3.1), each row on its own: repeats of 2 or more as a run, the rest as literals.
function packBits(plane: Uint8Array, cols: number) {
  const out: number[] = [];
  for (let r = 0; r < plane.length; r += cols) {
    const row = plane.subarray(r, r + cols);
    for (let i = 0; i < row.length;) {
      let run = 1;
      while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
      if (run > 1) {
        out.push(257 - run, row[i]);
        i += run;
        continue;
      }
      let lit = 1;
      while (i + lit < row.length && lit < 128 && row[i + lit] !== row[i + lit - 1]) lit++;
      if (i + lit < row.length && lit > 1) lit--; // leave the start of the next repeat to it
      out.push(lit - 1, ...row.subarray(i, i + lit));
      i += lit;
    }
  }
  if (out.length % 2) out.push(0); // segments are padded to an even length
  return out;
}

// An RLE Lossless frame: header, then one segment per byte of each sample, high byte first.
export function writeRle(pixels: Uint8Array | Uint16Array, rows: number, cols: number) {
  const planes = pixels instanceof Uint16Array
    ? [Uint8Array.from(pixels, (v) => v >> 8), Uint8Array.from(pixels, (v) => v & 0xff)]
    : [pixels];
  const segments = planes.map((p) => packBits(p, cols));
  const header = new DataView(new ArrayBuffer(64));
  header.setUint32(0, segments.length, true);
  let offset = 64;
  segments.forEach((seg, i) => { header.setUint32(4 + 4 * i, offset, true); offset += seg.length; });
  return concat([new Uint8Array(header.buffer), ...segments.map((seg) => Uint8Array.from(seg))]);
}
