// In-browser DICOM loading: groups local files into series and assembles a uint16 volume.
// Handles single-frame series and multi-frame (enhanced) images in uncompressed
// little-endian transfer syntaxes.

export class DicomError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
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
const MAX_BYTES = 1.6e9;

const WANTED = {
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

const CHARSETS = {
  'ISO_IR 192': 'utf-8', 'ISO_IR 100': 'windows-1252', 'ISO_IR 101': 'iso-8859-2',
  'ISO_IR 126': 'iso-8859-7', 'ISO_IR 144': 'iso-8859-5', 'ISO_IR 148': 'windows-1254',
};

const COMPRESSED = {
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
export function parseHeader(buffer) {
  const len = buffer.byteLength;
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const isVr = (a, b) => a >= 65 && a <= 90 && b >= 65 && b <= 90;
  const preamble = len > 132 && u8[128] === 0x44 && u8[129] === 0x49 && u8[130] === 0x43 && u8[131] === 0x4d;
  if (!preamble) {
    const group = len >= 8 ? dv.getUint16(0, true) : -1;
    if (group !== 0x0002 && group !== 0x0008) throw new DicomError('notDicom');
  }
  let explicit = preamble || isVr(u8[4], u8[5]);
  let transfer = explicit ? EXPLICIT_LE : IMPLICIT_LE;
  let decoder = new TextDecoder('windows-1252');
  const out = { framePositions: [] };
  const nested = {};

  const head = (p) => {
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

  const text = (p, n) => decoder.decode(u8.subarray(p, p + n)).replace(/[\0\s]+$/, '').replace(/^\s+/, '');

  const store = (h, p, ctx) => {
    const want = WANTED[h.tag];
    if (!want || ctx.skip) return;
    if (p + h.length > len) throw new NeedMore();
    const [key, vr] = want;
    const value = vr === 'US' ? (h.length >= 2 ? dv.getUint16(p, true) : 0) : text(p, h.length);
    if (ctx.top) {
      out[key] = value;
      if (key === 'charset') {
        const name = CHARSETS[value.split('\\').pop().trim()];
        if (name) decoder = new TextDecoder(name);
      }
    } else if (ctx.frame !== undefined && key === 'position') {
      out.framePositions[ctx.frame] = value;
    } else if (!(key in nested)) {
      nested[key] = value;
    }
  };

  // Elements from p until `end` or an item delimiter; returns the position after them,
  // or -1 once the top-level pixel data is reached.
  const walk = (p, end, ctx) => {
    while (p < end) {
      const h = head(p);
      if (h.tag === ITEM_DELIM) return p + 8;
      if (ctx.top && h.tag === PIXEL_DATA) {
        if (h.length === UNDEF) throw new DicomError('compressed', COMPRESSED[transfer] || transfer);
        out.pixelOffset = p + h.size;
        out.pixelLength = h.length;
        out.transfer = transfer;
        return -1;
      }
      const value = p + h.size;
      if (h.vr === 'SQ' || h.length === UNDEF) {
        const inner = ctx.skip || !DESCEND.has(h.tag) ? { skip: true } : { frame: ctx.frame, seq: h.tag };
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

  const sequence = (p, length, ctx) => {
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
    return p;
  };

  walk(preamble ? 132 : 0, Infinity, { top: true });
  for (const key of Object.keys(nested)) if (!(key in out)) out[key] = nested[key];
  return out;
}

async function readHeader(file) {
  const attempt = async (blob, last) => {
    try {
      return parseHeader(await blob.arrayBuffer());
    } catch (err) {
      if (!(err instanceof NeedMore)) throw err;
      if (last) throw new DicomError('noPixels');
      return null;
    }
  };
  if (file.size > HEADER_BYTES) {
    const info = await attempt(file.slice(0, HEADER_BYTES), false);
    if (info) return info;
  }
  return attempt(file, true);
}

const nums = (s) => (s ? String(s).split('\\').map(Number).filter((v) => !Number.isNaN(v)) : []);
const num = (s, d) => { const v = nums(s)[0]; return v === undefined ? d : v; };

export function personName(s) {
  if (!s) return '';
  return s.split('=')[0].split('^').map((p) => p.trim()).filter(Boolean).slice(0, 2).join(' ');
}

export function formatDate(s) {
  return s && /^\d{8}$/.test(s) ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : s || '';
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function hasDicomMagic(file) {
  if (file.size < 132) return false;
  const b = new Uint8Array(await file.slice(128, 132).arrayBuffer());
  return b[0] === 0x44 && b[1] === 0x49 && b[2] === 0x43 && b[3] === 0x4d;
}

// entries: [{ file, path }] with '/'-separated relative paths. Returns series, largest first.
export async function scanEntries(entries, onProgress, parseXml = parseAnalysis) {
  const lower = (e) => e.path.toLowerCase();
  let candidates = entries.filter((e) => lower(e).endsWith('.dcm') || lower(e).endsWith('.dicom'));
  if (!candidates.length) {
    const others = entries.filter((e) => !/\.(xml|txt|exe|dll|ini|html?|jpe?g|png|pdf|zip|js|css|json)$/i.test(e.path)
      && !/(^|\/)dicomdir$/i.test(e.path));
    const flags = await Promise.all(others.map((e) => hasDicomMagic(e.file)));
    candidates = others.filter((_, i) => flags[i]);
  }

  const groups = new Map();
  let done = 0;
  let firstError = null;
  await pool(candidates, 16, async (e) => {
    try {
      const info = await readHeader(e.file);
      if (info.rows && info.cols) {
        const key = `${info.seriesUid || ''}|${dirOf(e.path)}`;
        if (!groups.has(key)) groups.set(key, { key, dir: dirOf(e.path), uid: info.seriesUid || '', slices: [] });
        groups.get(key).slices.push({ file: e.file, info });
      }
    } catch (err) {
      if (!firstError || (err instanceof DicomError && err.code === 'compressed')) firstError = err;
    }
    done++;
    if (onProgress && done % 8 === 0) onProgress(done / candidates.length);
  });

  const analyses = [];
  for (const e of entries.filter((x) => lower(x).endsWith('.xml') && x.file.size < 5e6)) {
    const text = await e.file.text();
    if (!text.includes('itoothcontext')) continue;
    const parsed = parseXml(text);
    if (parsed) analyses.push({ path: e.path, ...parsed });
  }

  const series = [...groups.values()].map((g) => {
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
export function volumeStats(data, nx, ny, nz) {
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
  const percentile = (q) => {
    const target = q * count;
    let acc = 0;
    for (let v = 0; v < 65536; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 65535;
  };
  return { max, percentiles: [percentile(0.01), percentile(0.998)] };
}

export async function loadSeries(series, onProgress) {
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
  const along = (p) => p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2];
  const step = num(first.spacingBetween, 0) || num(first.sliceThickness, 0) || 1;

  const frames = [];
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
  if (nxy * nz * 2 > MAX_BYTES) throw new DicomError('tooLarge', `${Math.round((nxy * nz * 2) / 1048576)} MB`);
  let data;
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

  const diffs = [];
  for (let i = 1; i < nz; i++) diffs.push(frames[i].pos - frames[i - 1].pos);
  diffs.sort((x, y) => x - y);
  const dz = diffs.length ? Math.abs(diffs[diffs.length >> 1]) : num(first.sliceThickness, 1);
  const spacing = nums(first.pixelSpacing);
  const slope = num(first.slope, 1);
  let intercept = num(first.intercept, 0);
  if (signed) intercept -= 32768 * slope;
  const wc = nums(first.windowCenter)[0], ww = nums(first.windowWidth)[0];
  const stats = volumeStats(data, cols, rows, nz);

  const meta = {
    dims: [cols, rows, nz],
    spacing: [spacing[1] ?? 1, spacing[0] ?? 1, dz || 1],
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

// CS 3D Imaging context file: arches, nerve canals and display defaults.
export function parseAnalysis(text) {
  const doc = new DOMParser().parseFromString(text.replace(/\0+/g, '').trim(), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const q = (sel, root = doc) => root.querySelector(sel);
  const points = (el) => [...el.children].filter((c) => c.tagName === 'Point')
    .map((p) => ['x', 'y', 'z'].map((k) => Number(p.getAttribute(k))));

  const result = {
    name: q('IToothContext > Header > Name')?.textContent || '',
    reference: q('IToothContext > Header > Reference')?.textContent?.trim() || '',
    arches: [], canals: [], lut: null, ortho: null,
  };

  const lut = q('VolumeContext > Lut2D');
  if (lut?.getAttribute('windowlevel')) {
    result.lut = { center: Number(lut.getAttribute('windowlevel')), width: Number(lut.getAttribute('windowwidth')) };
  }
  const ortho = q('VolumeContext > OrthoPositions');
  if (ortho) result.ortho = ['x', 'y', 'z'].map((k) => Number(ortho.getAttribute(k) || 0));

  const names = {};
  doc.querySelectorAll('GraphicObjects > MultiResamples > Resample').forEach((r) => {
    names[r.getAttribute('resampleUid')] = r.getAttribute('name') || '';
  });

  doc.querySelectorAll('MultiResamplesTools > ResamplesTool').forEach((tool) => {
    [...tool.children].filter((c) => c.tagName === 'Resample').forEach((res) => {
      const surface = [...res.children].find((c) => c.tagName === 'CurveSurface');
      if (!surface) return;
      const pts = points(surface);
      if (pts.length < 2) return;
      const id = res.getAttribute('id');
      const type = (tool.getAttribute('type') || '').replace(/^e_/, '');
      result.arches.push({ id, type, name: names[id] || type, points: pts });
    });
  });

  doc.querySelectorAll('GraphicObjects > Canals > Canal').forEach((canal) => {
    const pts = points(canal);
    if (pts.length < 2) return;
    result.canals.push({
      name: canal.getAttribute('name') || 'Canal',
      radius: Number(canal.getAttribute('radius') || 1),
      color: ['R', 'G', 'B'].map((k) => Number(canal.getAttribute(k) ?? 1)),
      points: pts,
    });
  });

  return result;
}

// Collect files from a drag-and-drop, descending into folders. Chrome cannot read dropped
// folders through webkitGetAsEntry on file:// pages, so File System Access handles go first.
export async function entriesFromDrop(dataTransfer) {
  // Everything must be taken synchronously: the DataTransfer is emptied once the event returns.
  const items = [...dataTransfer.items].filter((it) => it.kind === 'file');
  const handles = items.map((it) => it.getAsFileSystemHandle?.()).filter(Boolean);
  const roots = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  const plain = [...dataTransfer.files];

  if (handles.length) {
    try {
      const out = [];
      const walk = async (h, path) => {
        if (h.kind === 'file') out.push({ file: await h.getFile(), path });
        else for await (const child of h.values()) await walk(child, `${path}/${child.name}`);
      };
      for (const h of await Promise.all(handles)) if (h) await walk(h, h.name);
      if (out.length) return out;
    } catch (err) {
      console.warn('File System Access drop failed', err);
    }
  }

  if (roots.length) {
    try {
      const out = [];
      const walk = async (entry) => {
        if (entry.isFile) {
          const file = await new Promise((res, rej) => entry.file(res, rej));
          out.push({ file, path: entry.fullPath.replace(/^\//, '') });
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
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

export function entriesFromInput(fileList) {
  return [...fileList].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}
