import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodecError, decodeJpegLossless, decodeRle } from '../src/codecs.ts';
import { writeJpegLossless, writeRle, segment, dhtSegment, concat, STANDARD, DEEP, COMPLETE } from './jpeg-writer.ts';
import type { HuffmanSpec, JpegOptions } from './jpeg-writer.ts';

const code = (c: string, detail?: string) => (err: unknown) =>
  err instanceof CodecError && err.code === c && (detail === undefined || err.detail === detail);
const hex = (s: string) => Uint8Array.from(s.match(/[0-9a-f]{2}/g) ?? [], (b) => parseInt(b, 16));

// Where marker FF m starts; entropy-coded data never holds one, since it stuffs every FF.
function marker(bytes: Uint8Array, m: number, from = 0) {
  for (let i = from; i + 1 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === m) return i;
  return -1;
}

function random(seed: number) {
  return () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
}

// A CT-like slice: a slow gradient with a little noise.
function smooth(w: number, h: number, precision: number, seed = 1) {
  const rnd = random(seed), max = 2 ** precision - 1;
  return Uint16Array.from({ length: w * h }, (_, i) => {
    const v = max / 2 + ((i % w) - Math.floor(i / w)) * (max / 300) + (rnd() - 0.5) * (max / 40);
    return Math.max(0, Math.min(max, Math.round(v)));
  });
}

const noise = (w: number, h: number, precision: number, seed = 1) => {
  const rnd = random(seed);
  return Uint16Array.from({ length: w * h }, () => Math.floor(rnd() * 2 ** precision));
};

function roundTrip(pixels: Uint16Array, w: number, h: number, opts: JpegOptions) {
  const img = decodeJpegLossless(writeJpegLossless(pixels, w, h, opts));
  const pt = opts.pt ?? 0;
  assert.deepEqual([img.width, img.height, img.precision], [w, h, opts.precision]);
  assert.deepEqual(img.pixels, pixels.map((v) => (v >> pt) << pt), JSON.stringify(opts));
}

test('decodes a lossless JPEG assembled bit by bit from T.81', () => {
  // 3×2 samples, 8 bits, predictor 1, the codes of Table K.3 (category 0: 00, 1: 010, 2: 011, 4: 101).
  //   130 = 128 (2^(P-1)) + 2: 011 10     131 = left + 1: 010 1       129 = left - 2: 011 01
  //   128 = above - 2: 011 01             128 = left + 0: 00          140 = left + 12: 101 1100
  // A negative difference sends the low bits of diff - 1 (-2 -> 01); 1-bits pad the last byte.
  const bits = '01110 0101 01101 01101 00 1011100 1111'.replace(/ /g, '');
  const scan = Uint8Array.from(bits.match(/.{8}/g) ?? [], (b) => parseInt(b, 2));
  const k3 = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const jpeg = concat([
    Uint8Array.of(0xff, 0xd8),
    Uint8Array.of(0xff, 0xc3, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0),
    Uint8Array.of(0xff, 0xc4, 0, 31, 0, ...k3),
    Uint8Array.of(0xff, 0xda, 0, 8, 1, 1, 0, 1, 0, 0),
    scan,
    Uint8Array.of(0xff, 0xd9),
  ]);
  const pixels = Uint16Array.of(130, 131, 129, 128, 128, 140);
  assert.deepEqual(decodeJpegLossless(jpeg), { width: 3, height: 2, precision: 8, pixels });
  // The test writer produces the same bytes, apart from the order of its segments.
  const table: HuffmanSpec = { bits: k3.slice(0, 16), values: k3.slice(16) };
  const written = writeJpegLossless(pixels, 3, 2, { precision: 8, table });
  assert.deepEqual(written.subarray(written.length - 6), concat([scan, Uint8Array.of(0xff, 0xd9)]));
});

test('decodes lossless JPEGs written by libjpeg-turbo', () => {
  // libjpeg-turbo 3.2 (through imagecodecs), 16 bits, predictors 1 and 6, with a JFIF APP0 segment
  // and optimised tables. Its differences include 32768 (category 16) and others that wrap modulo 2^16.
  const img16 = [
    0, 65535, 32768, 0, 1, 65534, 32767, 32769, 65535, 0, 0, 32768, 40000, 3, 65535, 12345,
    32768, 32768, 1, 65535, 0, 32768, 2, 65533, 7, 70, 700, 7000, 60000, 6000, 600, 60,
    0, 0, 0, 0, 65535, 65535, 65535, 65535,
  ];
  const pred1 = hex(`
    ffd8ffe000104a46494600010100000100010000ffc3000b100005000801011100ffc4001d000001030501000000000000000000000000010f100203
    0a0d0e06ffda000801010001000088c00045a18000a9149bc4078f0edf6074c0000c00052b18001b4c0037bfc9db7139c783f5a21aae7c78ec00807f
    ffd9`);
  const pred6 = hex(`
    ffd8ffe000104a46494600010100000100010000ffc3000b100005000801011100ffc4001e00000201030500000000000000000000000e0f01020d10
    000307080affda0008010100060000c8400064d08000aa10003a5fff00b70fd63cb4bc0e10000bff00f00007ff00f91e0870e000233f0d000c0084c2
    98bcfe372d08900da7ba27b1c7be59acc0a46963b7e895f4077fffd9`);
  for (const jpeg of [pred1, pred6]) {
    assert.deepEqual(decodeJpegLossless(jpeg), { width: 8, height: 5, precision: 16, pixels: Uint16Array.from(img16) });
  }

  // 12 bits, predictor 7.
  const pred7 = hex(`
    ffd8ffe000104a46494600010100000100010000ffc3000b0c0006000701011100ffc4001700010101010000000000000000000000000607050bffda
    0008010100070000e03361777ba6d76c1ad525eea834573beadfbc7b5a58eaa2ea8d495d5ed2a8d2698ae90fd8bf7ef19d79bfffd9`);
  const ramp = [
    26, 123, 182, 305, 382, 475, 571, 48, 167, 221, 321, 416, 514, 599, 79, 166, 256, 348, 443, 568, 627,
    137, 232, 302, 395, 492, 576, 695, 155, 274, 361, 454, 516, 618, 719, 204, 302, 394, 484, 551, 678, 753,
  ];
  assert.deepEqual(decodeJpegLossless(pred7), { width: 7, height: 6, precision: 12, pixels: Uint16Array.from(ramp) });

  // From the test writer, as libjpeg-turbo decodes it: 12 bits, predictor 5, point transform 2, a restart
  // interval per line and fill bytes before each RST marker.
  const restarts = hex(`
    ffd8ffc3000b0c0004000501011100ffc400240000010501010101010101010101010000000102030405060708090a0b0c0d0e0f10ffdd00040005ff
    da0008010100050002fc18fef3f5ff0080093fffffffd00fc01feff7f92cffffffd1fc02febac3f912ffffffd2fdff00fe003fbfff00e00343ffd9`);
  const expected = [100, 4000, 4092, 0, 16, 2048, 2048, 8, 4092, 1200, 12, 3000, 3000, 3000, 4, 4092, 0, 4092, 0, 64];
  assert.deepEqual(decodeJpegLossless(restarts).pixels, Uint16Array.from(expected));
});

test('round-trips every predictor at 8, 12 and 16 bits', () => {
  for (const precision of [8, 12, 16]) {
    for (let predictor = 1; predictor <= 7; predictor++) {
      roundTrip(smooth(37, 23, precision, predictor), 37, 23, { precision, predictor });
      roundTrip(noise(19, 11, precision, predictor), 19, 11, { precision, predictor });
    }
  }
  roundTrip(smooth(64, 64, 2), 64, 64, { precision: 2, predictor: 4 });
});

test('applies the point transform', () => {
  for (const [precision, pt] of [[12, 1], [12, 3], [16, 4], [16, 15], [8, 7], [2, 1]]) {
    for (const predictor of [1, 4, 6]) roundTrip(smooth(21, 13, precision, pt), 21, 13, { precision, predictor, pt });
  }
});

test('restarts prediction at every restart interval', () => {
  const w = 23, h = 9;
  for (const restart of [w, 3 * w, w * h, w * h + 5, 1, 7, 2 * w + 3]) {
    for (const predictor of [1, 2, 4, 7]) {
      for (const fill of [false, true]) {
        roundTrip(smooth(w, h, 12, restart), w, h, { precision: 12, predictor, restart, fill });
        roundTrip(noise(w, h, 16, restart), w, h, { precision: 16, predictor, restart, fill, pt: 2 });
      }
    }
  }
  // The markers are there, numbered 0–7 and round again.
  const jpeg = writeJpegLossless(smooth(w, h, 12), w, h, { precision: 12, restart: w });
  const rst = [...jpeg.keys()].filter((i) => jpeg[i] === 0xff && jpeg[i + 1] >> 3 === 0x1a).map((i) => jpeg[i + 1] & 7);
  assert.deepEqual(rst, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('decodes extreme differences, including category 16', () => {
  for (let predictor = 1; predictor <= 7; predictor++) {
    roundTrip(noise(64, 48, 16, predictor), 64, 48, { precision: 16, predictor });
  }
  // From the middle value 32768, 0 and 32768 again are both 32768 away; 65535 then wraps around to 0.
  const jumps = Uint16Array.of(0, 32768, 0, 65535, 0, 32768, 32768, 65535, 1, 32767, 65535, 0);
  for (const table of [STANDARD, DEEP, COMPLETE]) {
    for (let predictor = 1; predictor <= 7; predictor++) {
      roundTrip(jumps, 4, 3, { precision: 16, predictor, table });
      roundTrip(jumps, 4, 3, { precision: 16, predictor, table, restart: 5 });
    }
  }
});

test('decodes images a single sample wide or high', () => {
  for (const [w, h] of [[1, 1], [1, 17], [17, 1]]) {
    for (let predictor = 1; predictor <= 7; predictor++) {
      for (const precision of [8, 16]) {
        roundTrip(noise(w, h, precision, w + predictor), w, h, { precision, predictor });
        roundTrip(noise(w, h, precision, h + predictor), w, h, { precision, predictor, restart: 1 });
      }
    }
  }
});

test('reads long and complete codes, several tables and redefined tables', () => {
  const px = smooth(31, 17, 16);
  for (const table of [DEEP, COMPLETE]) roundTrip(px, 31, 17, { precision: 16, predictor: 6, table });
  // A segment holding an AC table and two DC tables before the scan's own, which uses Td 2.
  const others = [{ id: 0x10, spec: DEEP }, { id: 0, spec: DEEP }, { id: 1, spec: COMPLETE }];
  roundTrip(px, 31, 17, { precision: 16, others, tableId: 2 });
  // Table 3 defined as DEEP in an earlier segment, then redefined as STANDARD; APPn and COM are skipped.
  const before = [
    segment(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    segment(0xfe, [...Buffer.from('lossless test')]),
    dhtSegment([{ id: 3, spec: DEEP }]),
    segment(0xe1, new Uint8Array(300).fill(0xff)),
  ];
  roundTrip(px, 31, 17, { precision: 16, tableId: 3, before });
  // An AC table (class 1) numbered like the scan's DC table must not replace it.
  const jpeg = writeJpegLossless(px, 31, 17, { precision: 16 }), sos = marker(jpeg, 0xda);
  const withAc = concat([jpeg.subarray(0, sos), dhtSegment([{ id: 0x10, spec: DEEP }]), jpeg.subarray(sos)]);
  assert.deepEqual(decodeJpegLossless(withAc).pixels, px);
});

test('names lossy, arithmetic, hierarchical and colour JPEG as unsupported', () => {
  const jpeg = writeJpegLossless(smooth(8, 8, 12), 8, 8, { precision: 12 });
  const sof = marker(jpeg, 0xc3);
  const withMarker = (m: number) => { const j = jpeg.slice(); j[sof + 1] = m; return j; };
  const names: [number, string][] = [
    [0xc0, 'JPEG Baseline'], [0xc1, 'JPEG Extended'], [0xc2, 'JPEG Progressive'],
    [0xc7, 'JPEG Lossless hierarchical'], [0xcb, 'JPEG Lossless arithmetic'],
  ];
  for (const [m, name] of names) assert.throws(() => decodeJpegLossless(withMarker(m)), code('compressed', name));

  const color = concat([Uint8Array.of(0xff, 0xd8), segment(0xc3, [8, 0, 8, 0, 8, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0])]);
  assert.throws(() => decodeJpegLossless(color), code('compressed', 'JPEG Lossless, 3 components'));
  const dnl = concat([Uint8Array.of(0xff, 0xd8), segment(0xc3, [8, 0, 0, 0, 8, 1, 1, 0x11, 0])]);
  assert.throws(() => decodeJpegLossless(dnl), code('compressed', 'JPEG Lossless with DNL'));
});

test('rejects damaged JPEG streams', () => {
  const w = 16, h = 12, px = smooth(w, h, 12);
  const good = writeJpegLossless(px, w, h, { precision: 12, predictor: 5, restart: 2 * w });
  const sof = marker(good, 0xc3), sos = marker(good, 0xda);
  const patched = (at: number, ...bytes: number[]) => { const j = good.slice(); j.set(bytes, at); return j; };
  const invalid = code('invalid');

  // Every cut, except of the final EOI, loses samples.
  for (let n = 0; n < good.length - 2; n++) assert.throws(() => decodeJpegLossless(good.subarray(0, n)), invalid, `cut at ${n}`);
  assert.equal(decodeJpegLossless(good.subarray(0, good.length - 2)).pixels.length, w * h);

  assert.throws(() => decodeJpegLossless(patched(0, 0)), invalid); // no SOI
  assert.throws(() => decodeJpegLossless(patched(sof + 4, 1)), invalid); // precision 1
  assert.throws(() => decodeJpegLossless(patched(sof + 4, 17)), invalid);
  assert.throws(() => decodeJpegLossless(patched(sos + 7, 0)), invalid); // predictor 0
  assert.throws(() => decodeJpegLossless(patched(sos + 7, 8)), invalid);
  assert.throws(() => decodeJpegLossless(patched(sos + 9, 12)), invalid); // point transform >= precision
  assert.throws(() => decodeJpegLossless(patched(sos + 6, 0x10)), invalid); // table 1 is not defined
  assert.throws(() => decodeJpegLossless(patched(sos + 4, 2)), invalid); // two components in the scan
  // RST markers out of order, or one missing.
  const rst = marker(good, 0xd1, sos);
  assert.throws(() => decodeJpegLossless(patched(rst + 1, 0xd2)), invalid);
  assert.throws(() => decodeJpegLossless(concat([good.subarray(0, rst), good.subarray(rst + 2)])), invalid);
  // An interval a byte short, its marker still there.
  assert.throws(() => decodeJpegLossless(concat([good.subarray(0, rst - 1), good.subarray(rst)])), invalid);
  // The scan before the frame header.
  const scanFirst = concat([Uint8Array.of(0xff, 0xd8), good.subarray(sos), good.subarray(2, sos)]);
  assert.throws(() => decodeJpegLossless(scanFirst), invalid);

  // The scan's table with more codes than their lengths allow (three of 1 bit), or a category beyond 16.
  const dht = marker(good, 0xc4);
  assert.throws(() => decodeJpegLossless(patched(dht + 5, 3, 0, 3)), invalid);
  assert.throws(() => decodeJpegLossless(patched(dht + 21, 17)), invalid);

  // Codes DEEP leaves unassigned (it has none starting 11).
  const header = writeJpegLossless(Uint16Array.of(0), 1, 1, { precision: 8, table: DEEP });
  const unassigned = concat([header.subarray(0, marker(header, 0xda) + 10), Uint8Array.of(0xff, 0, 0xff, 0, 0xff, 0xd9)]);
  assert.throws(() => decodeJpegLossless(unassigned), invalid);
});

test('refuses oversized frames before allocating them', () => {
  const frame = (w: number, h: number) => concat([
    Uint8Array.of(0xff, 0xd8),
    segment(0xc3, [16, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]),
    dhtSegment([{ id: 0, spec: STANDARD }]),
    segment(0xda, [1, 1, 0, 1, 0, 0]),
    new Uint8Array(1000),
  ]);
  const t0 = performance.now();
  assert.throws(() => decodeJpegLossless(frame(65535, 65535)), code('invalid'));
  // 64 M samples is allowed, but 1000 bytes cannot hold them.
  assert.throws(() => decodeJpegLossless(frame(8192, 8192)), code('invalid'));
  assert.ok(performance.now() - t0 < 200);
});

// Damaged files must fail with a CodecError, or decode to something of the declared size.
function survives(decode: () => { length: number } | null, label: string) {
  let out;
  try {
    out = decode();
  } catch (err) {
    if (err instanceof CodecError) return;
    throw new Error(`${label}: ${err}`);
  }
  assert.ok(out, label);
}

test('survives random corruption of JPEG streams', () => {
  const rnd = random(99);
  const bases = [
    writeJpegLossless(smooth(40, 30, 16), 40, 30, { precision: 16, predictor: 4, restart: 40, fill: true }),
    writeJpegLossless(noise(25, 20, 12), 25, 20, { precision: 12, predictor: 7, table: DEEP, pt: 1 }),
    writeJpegLossless(noise(30, 10, 16), 30, 10, { precision: 16, predictor: 1, table: COMPLETE, restart: 7 }),
  ];
  const until = performance.now() + 1000;
  for (let i = 0; performance.now() < until; i++) {
    const base = bases[i % bases.length];
    let j = base.slice();
    for (let k = 1 + Math.floor(rnd() * 4); k > 0; k--) j[Math.floor(rnd() * j.length)] = Math.floor(rnd() * 256);
    if (rnd() < 0.2) j = j.subarray(0, Math.floor(rnd() * j.length));
    survives(() => {
      const img = decodeJpegLossless(j);
      assert.equal(img.pixels.length, img.width * img.height);
      assert.ok(img.pixels.every((v) => v < 2 ** img.precision), 'samples stay within the precision');
      return img.pixels;
    }, `JPEG mutation ${i}`);
  }
});

test('round-trips RLE Lossless at 8 and 16 bits', () => {
  // Rows of 300 hold runs and literals longer than the 128 one header can describe.
  const rows = 7, cols = 300, rnd = random(5);
  const value = (i: number) => (i % cols < 140 ? 1000 : i % cols < 290 ? Math.floor(rnd() * 65536) : (i % 3) * 300);
  const px16 = Uint16Array.from({ length: rows * cols }, (_, i) => value(i));
  const px8 = Uint8Array.from(px16, (v) => v & 0xff);
  assert.deepEqual(decodeRle(writeRle(px16, rows, cols), rows, cols, 16), px16);
  assert.deepEqual(decodeRle(writeRle(px8, rows, cols), rows, cols, 8), px8);
  for (const [r, c] of [[1, 1], [1, 2], [3, 129], [2, 257]]) {
    const small = Uint16Array.from({ length: r * c }, () => Math.floor(rnd() * 4) * 21845);
    assert.deepEqual(decodeRle(writeRle(small, r, c), r, c, 16), small);
  }
});

// A one-segment RLE frame around the given PackBits bytes.
function rleFrame(...packed: number[]) {
  const header = new Uint8Array(64);
  header.set([1, 0, 0, 0, 64]);
  return concat([header, Uint8Array.from(packed)]);
}

test('reads RLE no-op headers and ignores segment padding', () => {
  // 128 is a no-op; 254 repeats 9 three times; 1 copies two bytes; the zeros are padding.
  assert.deepEqual(decodeRle(rleFrame(128, 254, 9, 1, 5, 6, 0, 0), 1, 5, 8), Uint8Array.of(9, 9, 9, 5, 6));
});

test('names colour RLE as unsupported and rejects damaged RLE', () => {
  const px = smooth(10, 6, 16);
  const good = writeRle(px, 6, 10);
  const patched = (at: number, value: number) => {
    const j = good.slice();
    new DataView(j.buffer).setUint32(at, value, true);
    return j;
  };
  const invalid = code('invalid');

  assert.throws(() => decodeRle(good, 6, 10, 32), code('compressed', 'RLE 32-bit'));
  assert.throws(() => decodeRle(patched(0, 6), 6, 10, 16), code('compressed', 'RLE color'));
  assert.throws(() => decodeRle(patched(0, 1), 6, 10, 16), invalid);
  assert.throws(() => decodeRle(patched(0, 0), 6, 10, 16), invalid);
  assert.throws(() => decodeRle(patched(4, 60), 6, 10, 16), invalid); // inside the header
  assert.throws(() => decodeRle(patched(8, good.length + 1), 6, 10, 16), invalid); // past the end
  assert.throws(() => decodeRle(patched(8, 64), 6, 10, 16), invalid); // ends before it starts
  assert.throws(() => decodeRle(good, 7, 10, 16), invalid); // segments decode short
  assert.throws(() => decodeRle(rleFrame(254, 9), 1, 5, 8), invalid);
  assert.throws(() => decodeRle(rleFrame(254), 1, 3, 8), invalid); // a repeat without its byte
  assert.throws(() => decodeRle(rleFrame(4, 1, 2, 3), 1, 5, 8), invalid); // a literal past the end
  assert.throws(() => decodeRle(good, 0, 10, 16), invalid);
  assert.throws(() => decodeRle(good, 70000, 70000, 16), invalid);
  // Without padding, every cut loses a sample.
  const last = writeRle(Uint16Array.of(1, 2, 3), 1, 3);
  for (let n = 0; n < last.length; n++) assert.throws(() => decodeRle(last.subarray(0, n), 1, 3, 16), invalid);
});

test('survives random corruption of RLE frames', () => {
  const rnd = random(7);
  const base = writeRle(smooth(40, 30, 16), 30, 40);
  const until = performance.now() + 500;
  for (let i = 0; performance.now() < until; i++) {
    let j = base.slice();
    for (let k = 1 + Math.floor(rnd() * 4); k > 0; k--) j[Math.floor(rnd() * j.length)] = Math.floor(rnd() * 256);
    if (rnd() < 0.2) j = j.subarray(0, Math.floor(rnd() * j.length));
    survives(() => decodeRle(j, 30, 40, 16), `RLE mutation ${i}`);
  }
});
