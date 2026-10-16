import { Viewport } from './viewport.js';
import { VolumeView } from './vr.js';
import * as R from './reslice.js';
import { scanEntries, loadSeries, entriesFromDrop, entriesFromInput } from './dicom.js';
import { makePhantom } from './phantom.js';
import { createReport, CSS_PER_MM, PIXEL_RATIO } from './report.js';
import { drawLogo } from './brand.js';
import { t, setLanguage, detectLanguage, getLanguage, LANGUAGES, localeFor, rememberLanguageInUrl } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const REPO_URL = 'https://github.com/kitsorfan/dental-cbct-viewer';
const CREATOR = 'Kitsos Orfanopoulos';
const CROSS_STEPS = [0.5, 1, 2, 5]; // mm
const LEGACY_STORAGE_KEYS = ['dental-cbct-viewer.lang']; // written by v1.0.0, removed on start
const KINDS_2D = ['pano', 'axial', 'cross', 'coronal', 'sagittal'];
const COLORS = {
  axial: '#4ea1ff', coronal: '#3fd08f', sagittal: '#ff9f43',
  pano: '#f2cf4a', cross: '#ff5fa8', vr: '#2ec4b6', measure: '#7ef0ff',
};
// [left, right, top, bottom]
const EDGE_LABELS = {
  axial: ['R', 'L', 'A', 'P'],
  coronal: ['R', 'L', 'S', 'I'],
  sagittal: ['A', 'P', 'S', 'I'],
  pano: ['R', 'L', 'S', 'I'],
  cross: ['edge.buccal', 'edge.lingual', 'S', 'I'],
};
const PRESETS = {
  bone: { c: 1300, w: 3000 },
  teeth: { c: 1900, w: 2600 },
  soft: { c: 150, w: 1000 },
  scanner: { c: 1048, w: 4096 },
  auto: { c: 0, w: 0 },
};
const VR_PRESETS = {
  bone: { mode: 0, hu: 800 },
  teeth: { mode: 0, hu: 2300 },
  mip: { mode: 1, hu: 400 },
  xray: { mode: 2, level: 0.3 },
};

const S = {
  series: [], // { id, label, local }
  meta: null,
  vol: null,
  cursor: [0, 0, 0],
  wl: { c: 1300, w: 3000 },
  invert: false,
  lut: null,
  tool: 'navigate',
  showCanals: true,
  showGuides: true,
  arches: [],
  archIdx: -1,
  arch: null,
  panoOffset: 0,
  panoThick: 8,
  panoMode: 'avg',
  csIndex: 0,
  csMm: 0,
  csStep: 1,
  csWidth: 40,
  canals: [],
  measures: [],
  measuring: null,
  angleDraft: null,
  angleHover: null,
  drawing: null,
  drawHover: null,
  hoverKind: null,
  vrRange: [0, 1],
  message: null,
};

const views = {};
let vr = null;

// ---------------------------------------------------------------- rendering loop

const dirty = new Set();
let frame = 0;

function requestDraw(kind) {
  if (kind) dirty.add(kind);
  else KINDS_2D.forEach((k) => dirty.add(k));
  if (!frame) frame = requestAnimationFrame(drawAll);
}

function drawAll() {
  frame = 0;
  for (const k of dirty) views[k].draw(S.lut);
  dirty.clear();
}

const mm = (v) => v / S.vol.sx;
const rounded = () => S.cursor.map((v) => Math.round(v));

function planeFor(kind) {
  const vol = S.vol;
  const [ix, iy, iz] = rounded();
  switch (kind) {
    case 'axial': return { key: `a${iz}`, mkey: `a${iz}`, make: () => R.axial(vol, iz) };
    case 'coronal': return { key: `c${iy}`, mkey: `c${iy}`, make: () => R.coronal(vol, iy) };
    case 'sagittal': return { key: `s${ix}`, mkey: `s${ix}`, make: () => R.sagittal(vol, ix) };
    case 'pano': {
      if (!S.arch) return { key: 'none', mkey: 'none', make: () => null };
      const mkey = `p${S.archIdx}:${S.panoOffset}`;
      return {
        key: `${mkey}:${S.panoThick}:${S.panoMode}`, mkey,
        make: () => R.panoramic(vol, S.arch, mm(S.panoOffset), mm(S.panoThick), S.panoMode),
      };
    }
    case 'cross': {
      if (!S.arch) return { key: 'none', mkey: 'none', make: () => null };
      const mkey = `x${S.archIdx}:${S.csIndex}:${S.panoOffset}`;
      return {
        key: `${mkey}:${S.csWidth}`, mkey,
        make: () => R.crossSection(vol, S.arch, S.csIndex, mm(S.panoOffset), mm(S.csWidth), 1),
      };
    }
  }
  return null;
}

function reslice(kind) {
  const vp = views[kind];
  const p = planeFor(kind);
  if (vp.sliceKey === p.key) return;
  vp.sliceKey = p.key;
  vp.measureKey = p.mkey;
  vp.setPlane(p.make());
}

function refresh() {
  if (!S.vol) return;
  KINDS_2D.forEach(reslice);
  requestDraw();
}

function buildLut() {
  if (!S.vol) return;
  const { slope, intercept, max } = S.vol;
  const lut = new Uint32Array(max + 1);
  const lo = S.wl.c - S.wl.w / 2;
  const k = 255 / S.wl.w;
  for (let v = 0; v <= max; v++) {
    let g = (v * slope + intercept - lo) * k;
    g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
    if (S.invert) g = 255 - g;
    lut[v] = 0xff000000 | (g << 16) | (g << 8) | g;
  }
  S.lut = lut;
  KINDS_2D.forEach((kind) => { views[kind].pixelsDirty = true; });
  renderStatusWl();
  requestDraw();
}

function renderStatusWl() {
  $('#statusWL').textContent = S.vol
    ? `W ${Math.round(S.wl.w)}  L ${Math.round(S.wl.c)} HU${S.invert ? `  ·  ${t('status.inverted')}` : ''}`
    : '';
}

// ---------------------------------------------------------------- coordinates

function imageToVoxel(kind, u, v, plane) {
  const { nz } = S.vol;
  const iu = u - 0.5, iv = v - 0.5;
  const z = nz - 1 - iv;
  switch (kind) {
    case 'axial': return [iu, iv, S.cursor[2]];
    case 'coronal': return [iu, S.cursor[1], z];
    case 'sagittal': return [S.cursor[0], iu, z];
    case 'pano': {
      if (!S.arch) return null;
      const a = S.arch;
      const i = clamp(Math.round(iu), 0, a.M - 1);
      const off = mm(S.panoOffset);
      return [a.x[i] + off * a.nx[i], a.y[i] + off * a.ny[i], z, i];
    }
    case 'cross': {
      const p = plane;
      if (!p || !S.arch) return null;
      const d = p.half - iu;
      return [p.cx + d * S.arch.nx[p.index], p.cy + d * S.arch.ny[p.index], z];
    }
  }
  return null;
}

function setCursor(p) {
  const { nx, ny, nz } = S.vol;
  S.cursor = [clamp(p[0], 0, nx - 1), clamp(p[1], 0, ny - 1), clamp(p[2], 0, nz - 1)];
}

// The cross-section position is kept in millimetres so stepping by 1 mm never drifts.
function setCross(index) {
  if (!S.arch) return;
  S.csIndex = clamp(Math.round(index), 0, S.arch.M - 1);
  S.csMm = S.csIndex * S.vol.sx;
}

function setCrossMm(value) {
  if (!S.arch) return;
  S.csMm = clamp(value, 0, (S.arch.M - 1) * S.vol.sx);
  S.csIndex = Math.round(S.csMm / S.vol.sx);
}

function navigate(vp, u, v) {
  const p = imageToVoxel(vp.kind, u, v, vp.plane);
  if (!p) return;
  setCursor(p);
  if (vp.kind === 'pano') setCross(p[3]);
  if (vp.kind === 'axial' && S.arch) {
    const near = R.nearestOnArch(S.arch, p[0], p[1]);
    if (near.dist * S.vol.sx < 15) setCross(near.index);
  }
  refresh();
}

// ---------------------------------------------------------------- interaction hooks

const hooks = {
  invalidate: (vp) => requestDraw(vp.kind),
  tool: () => S.tool,
  windowLevel(dx, dy) {
    const k = Math.max(1, S.wl.w / 300);
    S.wl.w = clamp(S.wl.w + dx * k, 20, 20000);
    S.wl.c += dy * k;
    $('#preset').value = 'custom';
    buildLut();
  },
  dragStart(vp, mode, pos) {
    const inside = vp.inside(pos.u, pos.v);
    if (mode === 'navigate') {
      navigate(vp, pos.u, pos.v);
    } else if (mode === 'measure' && inside) {
      S.measuring = { type: 'distance', kind: vp.kind, key: vp.measureKey, a: [pos.u, pos.v], b: [pos.u, pos.v], sx: vp.plane.sx, sy: vp.plane.sy };
    } else if (mode === 'angle' && inside) {
      const d = S.angleDraft;
      if (!d || d.kind !== vp.kind || d.key !== vp.measureKey) {
        S.angleDraft = { type: 'angle', kind: vp.kind, key: vp.measureKey, pts: [[pos.u, pos.v]], sx: vp.plane.sx, sy: vp.plane.sy };
      } else {
        d.pts.push([pos.u, pos.v]);
        if (d.pts.length === 3) {
          S.measures.push(d);
          S.angleDraft = null;
        }
      }
      requestDraw(vp.kind);
    } else if (mode === 'arch' && vp.kind === 'axial' && inside) {
      S.drawing = S.drawing || [];
      S.drawing.push([pos.u - 0.5, pos.v - 0.5, S.cursor[2]]);
      requestDraw('axial');
    } else if (mode === 'arch' && vp.kind !== 'axial') {
      setMessage('msg.arch.axial');
    }
  },
  dragMove(vp, mode, pos) {
    if (mode === 'navigate') navigate(vp, pos.u, pos.v);
    else if (mode === 'measure' && S.measuring) {
      S.measuring.b = [pos.u, pos.v];
      requestDraw(vp.kind);
    }
  },
  dragEnd(vp, mode) {
    if (mode === 'measure' && S.measuring) {
      const m = S.measuring;
      S.measuring = null;
      if (distanceMm(m) > 0.2) S.measures.push(m);
      requestDraw(vp.kind);
    }
  },
  hover(vp, pos) {
    S.hoverKind = pos ? vp.kind : null;
    if (S.drawing && vp.kind === 'axial') {
      S.drawHover = pos;
      requestDraw('axial');
    }
    if (S.angleDraft && S.angleDraft.kind === vp.kind) {
      S.angleHover = pos ? [pos.u, pos.v] : null;
      requestDraw(vp.kind);
    }
    const el = $('#statusHover');
    if (!pos || !S.vol || !vp.inside(pos.u, pos.v)) { el.textContent = ''; return; }
    const p = vp.plane;
    const raw = p.data[Math.floor(pos.v) * p.w + Math.floor(pos.u)];
    const hu = Math.round(raw * S.vol.slope + S.vol.intercept);
    const vox = imageToVoxel(vp.kind, pos.u, pos.v, vp.plane);
    const { sx, sy, sz } = S.vol;
    const where = vox ? `  ·  x ${(vox[0] * sx).toFixed(1)}  y ${(vox[1] * sy).toFixed(1)}  z ${(vox[2] * sz).toFixed(1)} mm` : '';
    el.textContent = `${t(`view.${vp.kind}`)}  ·  ${hu} HU${where}`;
  },
  scroll(vp, dir, e) {
    if (!S.vol) return;
    const fast = e && e.shiftKey ? 10 : 1;
    const c = S.cursor;
    const { nx, ny, nz } = S.vol;
    switch (vp.kind) {
      case 'axial': c[2] = clamp(Math.round(c[2]) - dir * fast, 0, nz - 1); break;
      case 'coronal': c[1] = clamp(Math.round(c[1]) + dir * fast, 0, ny - 1); break;
      case 'sagittal': c[0] = clamp(Math.round(c[0]) + dir * fast, 0, nx - 1); break;
      case 'pano':
        S.panoOffset = clamp(Math.round((S.panoOffset - dir * 0.5 * fast) * 10) / 10, -20, 20);
        break;
      case 'cross':
        setCrossMm(S.csMm + dir * fast * S.csStep);
        break;
    }
    refresh();
  },
  dblclick(vp) {
    if (S.tool === 'arch' && vp.kind === 'axial' && S.drawing) { finishArch(); return; }
    if (S.tool === 'angle') return;
    toggleMax(vp.el);
  },
  overlay: drawOverlay,
};

function distanceMm(m) {
  return Math.hypot((m.b[0] - m.a[0]) * m.sx, (m.b[1] - m.a[1]) * m.sy);
}

function angleDeg(pts, sx, sy) {
  const [a, b, c] = pts;
  const ux = (a[0] - b[0]) * sx, uy = (a[1] - b[1]) * sy;
  const vx = (c[0] - b[0]) * sx, vy = (c[1] - b[1]) * sy;
  const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
  return (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI;
}

function measureValue(m) {
  return m.type === 'angle' ? `${angleDeg(m.pts, m.sx, m.sy).toFixed(1)}°` : `${distanceMm(m).toFixed(2)} mm`;
}

// Maximise one view, or restore the grid when it is already maximised.
function toggleMax(el) {
  const grid = $('#grid');
  const on = !el.classList.contains('maximized');
  document.querySelectorAll('.view.maximized').forEach((v) => v.classList.remove('maximized'));
  grid.classList.toggle('max', on);
  if (on) el.classList.add('maximized');
  document.querySelectorAll('.view .expand').forEach((b) => {
    b.title = t(b.closest('.view').classList.contains('maximized') ? 'collapse.title' : 'expand.title');
  });
}

// ---------------------------------------------------------------- arches & canals

function selectArch(idx) {
  S.archIdx = idx;
  const entry = S.arches[idx];
  S.arch = entry ? (entry.built ||= R.buildArch(entry.points)) : null;
  S.panoOffset = 0;
  setCross(S.arch ? Math.floor(S.arch.M / 2) : 0);
  for (const c of S.canals) {
    if (!S.arch) { c.proj = null; continue; }
    c.proj = c.dense.map((p) => {
      const n = R.nearestOnArch(S.arch, p[0], p[1]);
      return n.index === 0 || n.index === S.arch.M - 1 ? null : [n.index, p[2]];
    });
  }
  fillArchSelect();
  refresh();
}

function archName(a) {
  if (a.custom) return t('arch.custom', { n: a.custom });
  return a.demo ? t('arch.demo') : a.name;
}

function fillArchSelect() {
  const sel = $('#arch');
  sel.innerHTML = '';
  if (!S.arches.length) {
    sel.append(new Option(t('arch.none'), '-1'));
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  S.arches.forEach((a, i) => sel.append(new Option(archName(a), String(i))));
  sel.value = String(S.archIdx);
}

function finishArch() {
  const pts = [];
  for (const p of S.drawing || []) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 3) pts.push(p);
  }
  S.drawing = null;
  S.drawHover = null;
  if (pts.length < 3) {
    setMessage('msg.arch.few');
    requestDraw('axial');
    return;
  }
  const n = S.arches.filter((a) => a.custom).length + 1;
  S.arches.push({ custom: n, type: 'Custom', points: pts });
  setTool('navigate');
  setMessage('msg.arch.created', { n });
  selectArch(S.arches.length - 1);
}

function cssColor(rgb, alpha = 1) {
  return `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${alpha})`;
}

// ---------------------------------------------------------------- overlay drawing

function path(ctx, pts, color, width, { dash = [], alpha = 1 } = {}) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.restore();
}

function ring(ctx, [x, y], r, color) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, Math.max(2.5, r), 0, Math.PI * 2);
  ctx.fillStyle = color.replace(/[\d.]+\)$/, '0.28)');
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function dot(ctx, [x, y], color, r = 3) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function label(ctx, str, x, y, { color = '#e8edf3', align = 'left', baseline = 'alphabetic', bg = null, size = 12, weight = 500 } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (bg) {
    const w = ctx.measureText(str).width;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const top = baseline === 'middle' ? y - size / 2 - 3 : baseline === 'top' ? y - 3 : y - size - 1;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(left - 5, top, w + 10, size + 7, 4);
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = bg ? 0 : 3;
  ctx.fillText(str, x, y);
  ctx.restore();
}

function crosshair(vp, ctx, X, Y, vColor, hColor) {
  const [x0, y0] = vp.toScreen(0, 0);
  const [x1, y1] = vp.toScreen(vp.plane.w, vp.plane.h);
  const g = 12;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.9;
  if (vColor && X >= x0 && X <= x1) {
    ctx.strokeStyle = vColor;
    ctx.beginPath();
    ctx.moveTo(X, y0); ctx.lineTo(X, Math.max(y0, Y - g));
    ctx.moveTo(X, Math.min(y1, Y + g)); ctx.lineTo(X, y1);
    ctx.stroke();
  }
  if (hColor && Y >= y0 && Y <= y1) {
    ctx.strokeStyle = hColor;
    ctx.beginPath();
    ctx.moveTo(x0, Y); ctx.lineTo(Math.max(x0, X - g), Y);
    ctx.moveTo(Math.min(x1, X + g), Y); ctx.lineTo(x1, Y);
    ctx.stroke();
  }
  ctx.restore();
}

// vp.report (off-screen exports): no crosshair or arch guides; optional numbered ticks.
function drawOverlay(vp, ctx) {
  const kind = vp.kind;
  const info = vp.el?.querySelector('.vinfo');
  const setInfo = (s) => { if (info) info.textContent = s; };
  if (!S.vol) { setInfo(''); return; }
  if (!vp.plane) {
    setInfo('');
    label(ctx, t('noarch.title'), vp.cssW / 2, vp.cssH / 2 - 10, { align: 'center', size: 14, color: '#c9d2dc' });
    label(ctx, t('noarch.hint'), vp.cssW / 2, vp.cssH / 2 + 12, { align: 'center', size: 12, color: '#8d99a6' });
    return;
  }

  const guides = S.showGuides && !vp.report;
  const nz = S.vol.nz;
  const [ix, iy, iz] = vp.slice ?? rounded();
  const P = (x, y) => vp.toScreen(x + 0.5, y + 0.5);
  const Z = (z) => nz - 1 - z;
  const a = S.arch;

  if (kind === 'axial') {
    if (guides && a) {
      const off = mm(S.panoOffset);
      const curve = (d) => {
        const pts = [];
        for (let i = 0; i < a.M; i += 2) pts.push(P(a.x[i] + d * a.nx[i], a.y[i] + d * a.ny[i]));
        return pts;
      };
      path(ctx, curve(off), COLORS.pano, 1.5, { alpha: 0.85 });
      const half = mm(S.panoThick) / 2;
      if (half > 1) {
        path(ctx, curve(off - half), COLORS.pano, 1, { dash: [4, 4], alpha: 0.45 });
        path(ctx, curve(off + half), COLORS.pano, 1, { dash: [4, 4], alpha: 0.45 });
      }
      const cp = views.cross.plane;
      if (cp) {
        const i = cp.index;
        const A = P(cp.cx + cp.half * a.nx[i], cp.cy + cp.half * a.ny[i]);
        const B = P(cp.cx - cp.half * a.nx[i], cp.cy - cp.half * a.ny[i]);
        path(ctx, [A, B], COLORS.cross, 2);
        label(ctx, 'B', A[0], A[1], { color: COLORS.cross, align: 'center', baseline: 'middle', size: 11, weight: 700 });
      }
    }
    if (S.showCanals) {
      for (const c of S.canals) {
        path(ctx, c.dense.map((p) => P(p[0], p[1])), c.css, 1.5, { dash: [5, 4], alpha: 0.6 });
        for (const q of R.crossings(c.dense, (p) => p[2] - iz)) ring(ctx, P(q[0], q[1]), c.radiusVox * vp.kx, c.css);
      }
    }
    if (S.drawing && !vp.report) {
      const pts = S.drawing.map((p) => P(p[0], p[1]));
      if (S.drawHover) pts.push([S.drawHover.X, S.drawHover.Y]);
      path(ctx, pts, COLORS.pano, 2, { dash: [6, 4] });
      for (const p of S.drawing) ring(ctx, P(p[0], p[1]), 4, 'rgba(242, 207, 74, 1)');
    }
    if (guides) {
      const [X, Y] = P(S.cursor[0], S.cursor[1]);
      crosshair(vp, ctx, X, Y, COLORS.sagittal, COLORS.coronal);
    }
    setInfo(t('info.slice', { n: iz + 1, total: nz }));
  }

  if (kind === 'coronal' || kind === 'sagittal') {
    const cor = kind === 'coronal';
    if (S.showCanals) {
      for (const c of S.canals) {
        path(ctx, c.dense.map((p) => P(cor ? p[0] : p[1], Z(p[2]))), c.css, 1.5, { dash: [5, 4], alpha: 0.5 });
        const hits = R.crossings(c.dense, cor ? (p) => p[1] - iy : (p) => p[0] - ix);
        for (const q of hits) ring(ctx, P(cor ? q[0] : q[1], Z(q[2])), c.radiusVox * vp.kx, c.css);
      }
    }
    if (guides) {
      const [X, Y] = P(cor ? S.cursor[0] : S.cursor[1], Z(S.cursor[2]));
      crosshair(vp, ctx, X, Y, cor ? COLORS.sagittal : COLORS.coronal, COLORS.axial);
    }
    setInfo(cor ? t('info.slice', { n: iy + 1, total: S.vol.ny }) : t('info.slice', { n: ix + 1, total: S.vol.nx }));
  }

  if (kind === 'pano') {
    if (S.showCanals) {
      for (const c of S.canals) {
        if (!c.proj) continue;
        const segs = [];
        let cur = [];
        for (const pr of c.proj) {
          if (!pr) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
          cur.push(P(pr[0], Z(pr[1])));
        }
        if (cur.length > 1) segs.push(cur);
        for (const seg of segs) {
          path(ctx, seg, c.css, 2 * c.radiusMm * vp.cssPerMm, { alpha: 0.32 });
          path(ctx, seg, c.css, 1.2, { alpha: 0.95 });
        }
      }
    }
    if (guides) {
      const [X, Y] = P(S.csIndex, Z(S.cursor[2]));
      crosshair(vp, ctx, X, Y, COLORS.cross, COLORS.axial);
    }
    const ticks = vp.report?.ticks ?? [];
    if (ticks.length) {
      const [, top] = vp.toScreen(0, 0);
      const [, bottom] = vp.toScreen(0, vp.plane.h);
      const [x0] = P(ticks[0].index, 0);
      const [x1] = P(ticks[ticks.length - 1].index, 0);
      ctx.save();
      ctx.fillStyle = 'rgba(255, 95, 168, 0.14)';
      ctx.fillRect(Math.min(x0, x1) - 2, top, Math.abs(x1 - x0) + 4, bottom - top);
      ctx.restore();
      const spacing = ticks.length > 1 ? Math.abs(x1 - x0) / (ticks.length - 1) : 99;
      const every = Math.max(1, Math.ceil(24 / spacing));
      const dense = ticks.length > 16;
      ticks.forEach((tick, k) => {
        const [X] = P(tick.index, 0);
        path(ctx, [[X, top], [X, bottom]], COLORS.cross, 1, { dash: dense ? [] : [3, 3], alpha: dense ? 0.5 : 0.75 });
        if (k % every === 0) {
          label(ctx, String(tick.label), X, top + 4, { align: 'center', baseline: 'top', color: '#0b1016', bg: COLORS.cross, size: dense ? 9 : 10, weight: 700 });
        }
      });
    }
    const name = S.arches[S.archIdx] ? archName(S.arches[S.archIdx]) : '';
    const off = S.panoOffset ? `  ·  ${t('info.offset', { v: `${S.panoOffset > 0 ? '+' : ''}${S.panoOffset.toFixed(1)}` })}` : '';
    setInfo(`${name}${off}`);
  }

  if (kind === 'cross') {
    const cp = vp.plane;
    const i = cp.index;
    if (S.showCanals) {
      const f = (p) => (p[0] - cp.cx) * a.tx[i] + (p[1] - cp.cy) * a.ty[i];
      for (const c of S.canals) {
        for (const q of R.crossings(c.dense, f)) {
          const d = (q[0] - cp.cx) * a.nx[i] + (q[1] - cp.cy) * a.ny[i];
          if (Math.abs(d) > cp.half) continue;
          ring(ctx, P(cp.half - d, Z(q[2])), c.radiusVox * vp.kx, c.css);
        }
      }
    }
    if (guides) {
      const [X, Y] = P(cp.half, Z(S.cursor[2]));
      crosshair(vp, ctx, X, Y, COLORS.pano, COLORS.axial);
    }
    setInfo(t('info.along', { pos: (i * S.vol.sx).toFixed(1), len: (a.length * S.vol.sx).toFixed(1) }));
  }

  drawMeasures(vp, ctx);
  drawEdgeLabels(vp, ctx);
  drawScaleBar(vp, ctx);
}

function drawMeasures(vp, ctx) {
  const list = S.measures.filter((m) => m.kind === vp.kind && m.key === vp.measureKey);
  if (!vp.report && S.measuring && S.measuring.kind === vp.kind) list.push(S.measuring);
  list.forEach((m) => {
    const n = S.measures.indexOf(m) + 1;
    const tag = vp.report && n ? `${n}: ` : '';
    if (m.type === 'angle') drawAngle(vp, ctx, m.pts, m, tag);
    else drawDistance(vp, ctx, m, tag);
  });
  const d = S.angleDraft;
  if (!vp.report && d && d.kind === vp.kind && d.key === vp.measureKey) {
    const pts = S.angleHover ? [...d.pts, S.angleHover] : d.pts;
    drawAngle(vp, ctx, pts, d, '');
  }
}

function drawDistance(vp, ctx, m, tag) {
  const A = vp.toScreen(...m.a), B = vp.toScreen(...m.b);
  path(ctx, [A, B], COLORS.measure, 2);
  dot(ctx, A, COLORS.measure);
  dot(ctx, B, COLORS.measure);
  const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
  label(ctx, `${tag}${distanceMm(m).toFixed(2)} mm`, mx + 8, my - 8, { color: '#0b1016', bg: COLORS.measure, size: 12, weight: 700 });
}

function drawAngle(vp, ctx, pts, m, tag) {
  const P = pts.map((p) => vp.toScreen(p[0], p[1]));
  path(ctx, P, COLORS.measure, 2);
  P.forEach((p) => dot(ctx, p, COLORS.measure));
  if (pts.length < 3) return;
  const [A, B, C] = P;
  const a1 = Math.atan2(A[1] - B[1], A[0] - B[0]);
  let da = Math.atan2(C[1] - B[1], C[0] - B[0]) - a1;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  ctx.save();
  ctx.strokeStyle = COLORS.measure;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(B[0], B[1], 22, a1, a1 + da, da < 0);
  ctx.stroke();
  ctx.restore();
  const mid = a1 + da / 2;
  label(ctx, `${tag}${angleDeg(pts, m.sx, m.sy).toFixed(1)}°`, B[0] + Math.cos(mid) * 34, B[1] + Math.sin(mid) * 34,
    { color: '#0b1016', bg: COLORS.measure, size: 12, weight: 700, align: 'center', baseline: 'middle' });
}

function drawEdgeLabels(vp, ctx) {
  const compact = vp.report?.compact;
  const [l, r, top, b] = EDGE_LABELS[vp.kind].map((s) => (s.includes('.') ? t(compact ? `${s}.short` : s) : s));
  const o = { color: 'rgba(232, 237, 243, 0.75)', size: compact ? 10 : 12, weight: 700 };
  label(ctx, l, 6, vp.cssH / 2, { ...o, baseline: 'middle' });
  label(ctx, r, vp.cssW - 6, vp.cssH / 2, { ...o, align: 'right', baseline: 'middle' });
  if (vp.report?.ticks) return;
  label(ctx, top, vp.cssW / 2, 6, { ...o, align: 'center', baseline: 'top' });
  label(ctx, b, vp.cssW / 2, vp.cssH - 6, { ...o, align: 'center' });
}

function drawScaleBar(vp, ctx) {
  const compact = vp.report?.compact;
  const target = (compact ? 24 : 90) / vp.cssPerMm;
  const len = [1, 2, 5, 10, 20, 50, 100].find((v) => v >= target * 0.6) ?? 100;
  const px = len * vp.cssPerMm;
  const x1 = vp.cssW - (compact ? 6 : 14), x0 = x1 - px, y = vp.cssH - (compact ? 6 : 26);
  ctx.save();
  ctx.strokeStyle = 'rgba(232, 237, 243, 0.8)';
  ctx.lineWidth = compact ? 1 : 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y - 3); ctx.lineTo(x0, y); ctx.lineTo(x1, y); ctx.lineTo(x1, y - 3);
  ctx.stroke();
  ctx.restore();
  label(ctx, `${len} mm`, (x0 + x1) / 2, y - (compact ? 4 : 6), { align: 'center', size: compact ? 8 : 11, color: 'rgba(232, 237, 243, 0.85)' });
}

// ---------------------------------------------------------------- exports

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fileStem() {
  const name = S.meta?.demo ? 'demo' : (S.meta?.patientName || 'scan');
  return name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'scan';
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const canvasBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

async function saveView(kind) {
  if (!S.vol) return;
  let canvas;
  if (kind === 'vr') {
    if (!vr || vr.failed) return;
    vr.draw(false);
    canvas = vr.canvas;
  } else {
    drawAll();
    canvas = views[kind].canvas;
  }
  const blob = await canvasBlob(canvas);
  if (blob) download(blob, `${fileStem()}-${kind}-${stamp()}.png`);
}

// One PNG of every visible view as laid out on screen, with a title strip.
async function saveLayout() {
  if (!S.vol) return;
  drawAll();
  if (vr && !vr.failed) vr.draw(false);
  const grid = $('#grid').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const strip = 40;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(grid.width * dpr);
  canvas.height = Math.round((grid.height + strip) * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0a0d11';
  ctx.fillRect(0, 0, grid.width, grid.height + strip);
  drawLogo(ctx, 10, 8, 24);
  label(ctx, t('app.name'), 42, 25, { size: 15, weight: 700, color: '#e6edf3' });
  label(ctx, patientLine(), grid.width - 12, 25, { size: 13, align: 'right', color: '#aab6c3' });
  for (const el of document.querySelectorAll('#grid > .view')) {
    if (!el.offsetParent) continue;
    const kind = el.dataset.view;
    const r = el.getBoundingClientRect();
    const x = r.left - grid.left, y = r.top - grid.top + strip;
    const head = el.querySelector('.vhead').getBoundingClientRect();
    const wrap = el.querySelector('.canvas-wrap').getBoundingClientRect();
    ctx.fillStyle = '#11161c';
    ctx.fillRect(x, y, r.width, head.height);
    dot(ctx, [x + 13, y + head.height / 2], COLORS[kind], 4.5);
    const info = el.querySelector('.vinfo').textContent;
    label(ctx, `${t(`view.${kind}`)}${info ? `   ${info}` : ''}`, x + 24, y + head.height / 2, { baseline: 'middle', size: 12, weight: 600 });
    const source = kind === 'vr' ? vr?.canvas : views[kind].canvas;
    if (source) ctx.drawImage(source, x + (wrap.left - r.left), y + (wrap.top - r.top), wrap.width, wrap.height);
  }
  const blob = await canvasBlob(canvas);
  if (blob) download(blob, `${fileStem()}-views-${stamp()}.png`);
}

// Off-screen render of a plane at a physical size for the report.
function renderPlane(kind, plane, wMm, hMm, extra = {}) {
  const vp = new Viewport(null, kind, { invalidate() {}, overlay: drawOverlay },
    { width: wMm * CSS_PER_MM, height: hMm * CSS_PER_MM, pixelRatio: PIXEL_RATIO });
  vp.setPlane(plane);
  vp.report = extra;
  vp.measureKey = extra.measureKey ?? null;
  vp.slice = extra.slice;
  vp.draw(S.lut);
  return vp.canvas;
}

function patientLine() {
  const m = S.meta;
  if (!m) return '';
  return [m.demo ? t('patient.demo') : m.patientName, m.birthDate && t('patient.dob', { v: m.birthDate }),
    m.studyDate && t('patient.scan', { v: m.studyDate })].filter(Boolean).join('  ·  ');
}

async function createPdfReport() {
  if (!S.vol) return;
  showLoading(t('report.creating'), 0.2);
  await new Promise((r) => setTimeout(r, 30));
  try {
    const m = S.meta;
    const { nx, ny, nz, sx, sy, sz } = S.vol;
    const now = new Date();
    const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, ''));
    const info = [
      [t('report.patient'), m.demo ? t('patient.demo') : m.patientName],
      [t('report.id'), m.patientId],
      [t('report.dob'), m.birthDate],
      [t('report.scanDate'), m.studyDate],
      [t('report.device'), [m.manufacturer, m.model].filter(Boolean).join(' ')],
      [t('report.kvp'), m.kvp ? `${m.kvp} kV` : ''],
      [t('report.volume'), t('report.voxels', { x: nx, y: ny, z: nz })],
      [t('report.voxel'), `${fmt(sx)} mm`],
      [t('report.fov'), `${(nx * sx).toFixed(1)} × ${(ny * sy).toFixed(1)} × ${(nz * sz).toFixed(1)} mm`],
      [t('report.analysis'), m.analysis?.name || ''],
      [t('report.window'), t('report.wl', { w: Math.round(S.wl.w), c: Math.round(S.wl.c) })],
      [t('report.acq'), m.comments],
    ];

    const [ix, iy, iz] = rounded();
    const axial = R.axial(S.vol, iz);
    const physical = (p) => (p.w * p.sx) / (p.h * p.sy);
    const panoPlane = views.pano.plane;
    const pano = panoPlane && {
      title: t('view.pano'),
      subtitle: [S.arches[S.archIdx] && archName(S.arches[S.archIdx]), `${S.panoThick} mm`].filter(Boolean).join(' · '),
      aspect: physical(panoPlane),
      render: (w, h, extra = {}) => renderPlane('pano', panoPlane, w, h, { ...extra, measureKey: extra.ticks ? null : views.pano.measureKey }),
    };

    const tiles = [];
    if (vr && !vr.failed && vr.ready) {
      tiles.push({ title: t('view.vr'), subtitle: $('#vrPreset').selectedOptions[0].textContent,
        render: (w, h) => vr.snapshot(w * CSS_PER_MM * PIXEL_RATIO, h * CSS_PER_MM * PIXEL_RATIO) });
    }
    tiles.push({ title: t('view.axial'), subtitle: t('info.slice', { n: iz + 1, total: nz }),
      render: (w, h) => renderPlane('axial', axial, w, h, { measureKey: `a${iz}`, slice: [ix, iy, iz] }) });
    if (!pano) {
      tiles.push({ title: t('view.coronal'), render: (w, h) => renderPlane('coronal', R.coronal(S.vol, iy), w, h, { measureKey: `c${iy}`, slice: [ix, iy, iz] }) });
      tiles.push({ title: t('view.sagittal'), render: (w, h) => renderPlane('sagittal', R.sagittal(S.vol, ix), w, h, { measureKey: `s${ix}`, slice: [ix, iy, iz] }) });
    }

    // Serial cross-sections every S.csStep mm along the whole arch (1 mm by default).
    let cross = null;
    if (pano) {
      const a = S.arch;
      const step = S.csStep;
      const lengthMm = (a.M - 1) * sx;
      const first = Math.ceil(2 / step) * step;
      const fmt = (v) => v.toFixed(step < 1 ? 1 : 0);
      const items = [];
      for (let k = 0; first + k * step <= lengthMm - 2 + 1e-6 && items.length < 400; k++) {
        const pos = first + k * step;
        items.push({ index: Math.round(pos / sx), label: k + 1, detail: `${fmt(pos)} mm` });
      }
      if (items.length) {
        const plane = (it) => R.crossSection(S.vol, a, it.index, mm(S.panoOffset), mm(S.csWidth), 1);
        cross = {
          title: t('report.cross.title'),
          subtitle: t('report.cross.caption', { step: String(step), width: S.csWidth }),
          range: (from, to, total) => t('report.cross.range', { from, to, total }),
          aspect: physical(plane(items[0])),
          items,
          render: (it, w, h) => renderPlane('cross', plane(it), w, h, { compact: true }),
        };
      }
    }

    const viewTiles = ['axial', 'cross', 'coronal', 'sagittal']
      .filter((k) => views[k].plane)
      .map((k) => ({
        title: t(`view.${k}`),
        subtitle: views[k].el.querySelector('.vinfo').textContent,
        render: (w, h) => renderPlane(k, views[k].plane, w, h, { measureKey: views[k].measureKey, slice: [ix, iy, iz] }),
      }));
    const measurements = S.measures.map((ms, i) => [
      String(i + 1),
      t(`view.${ms.kind}`),
      t(ms.type === 'angle' ? 'report.angle' : 'report.distance'),
      measureValue(ms),
    ]);

    const blob = await createReport({
      appName: t('app.name'),
      documentTitle: `${t('report.title')} – ${m.demo ? t('patient.demo') : m.patientName || ''}`,
      patient: m.demo ? t('patient.demo') : m.patientName || '',
      created: t('report.created', { v: now.toLocaleString(localeFor()) }),
      banner: m.demo ? t('msg.demo') : '',
      disclaimer: t('help.disclaimer'),
      pageLabel: (n, total) => t('report.page', { n, total }),
      titles: { overview: t('report.title') },
      info,
      pano,
      overviewTiles: tiles,
      cross,
      views: {
        title: t('report.views.title'),
        tiles: viewTiles,
        measurementsTitle: t('report.measurements'),
        none: t('report.none'),
        columns: [
          { label: '#', width: 12 },
          { label: t('report.col.view'), width: 52 },
          { label: t('report.col.type'), width: 52 },
          { label: t('report.col.value'), width: 66, align: 'right' },
        ],
        measurements,
      },
    });
    download(blob, `${fileStem()}-report-${stamp()}.pdf`);
  } catch (err) {
    console.error(err);
    setMessage('err.report', { msg: err.message });
  } finally {
    hideLoading();
    refresh();
    if (vr && !vr.failed) vr.render();
  }
}

// ---------------------------------------------------------------- UI wiring

function setMessage(key, vars = {}) {
  S.message = key ? { key, vars } : null;
  renderMessage();
}

function renderMessage() {
  const m = S.message;
  $('#statusMsg').textContent = m ? t(m.key, typeof m.vars === 'function' ? m.vars() : m.vars) : '';
}

function setTool(tool) {
  S.tool = tool;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  document.body.dataset.tool = tool;
  if (tool !== 'arch' && S.drawing) {
    S.drawing = null;
    requestDraw('axial');
  }
  if (tool !== 'angle' && S.angleDraft) {
    S.angleDraft = null;
    requestDraw();
  }
  if (tool === 'arch') setMessage('msg.arch.draw');
  else if (tool === 'angle') setMessage('msg.angle');
  else if (S.message && ['msg.arch.draw', 'msg.angle', 'msg.arch.axial'].includes(S.message.key)) setMessage(null);
}

function fillPresetSelect() {
  const preset = $('#preset');
  const value = preset.value;
  preset.innerHTML = '';
  for (const id of Object.keys(PRESETS)) preset.append(new Option(t(`preset.${id}`), id));
  preset.append(new Option(t('preset.custom'), 'custom'));
  preset.value = value || 'bone';
}

function applyPreset(id) {
  const p = PRESETS[id];
  if (!p || !S.vol) return;
  if (id === 'auto') {
    const [lo, hi] = S.meta.percentiles.map((v) => v * S.vol.slope + S.vol.intercept);
    S.wl = { c: (lo + hi) / 2, w: Math.max(50, hi - lo) };
  } else {
    S.wl = { c: p.c, w: p.w };
  }
  buildLut();
}

function vrHu(level) {
  const [lo, hi] = S.vrRange;
  return (lo + level * (hi - lo)) * S.vol.slope + S.vol.intercept;
}

function vrLevel(hu) {
  const [lo, hi] = S.vrRange;
  return clamp(((hu - S.vol.intercept) / S.vol.slope - lo) / (hi - lo), 0, 1);
}

function applyVrPreset(id) {
  if (!vr || vr.failed || !S.vol) return;
  const p = VR_PRESETS[id];
  vr.mode = p.mode;
  const level = p.level ?? vrLevel(p.hu);
  $('#vrLevel').value = level;
  applyVrLevel(level);
}

function applyVrLevel(level) {
  if (!vr || vr.failed || !S.vol) return;
  if (vr.mode === 2) {
    vr.gain = 1 + level * 20;
    $('#vrLevelOut').textContent = t('vr.gain', { v: vr.gain.toFixed(1) });
  } else {
    vr.iso = level;
    $('#vrLevelOut').textContent = `${Math.round(vrHu(level))} HU`;
  }
  vr.render();
}

function fillStepSelect() {
  const sel = $('#csStep');
  sel.innerHTML = '';
  for (const v of CROSS_STEPS) sel.append(new Option(t('cs.step', { v }), String(v)));
  sel.value = String(S.csStep);
}

function applyLanguage(lang, chosen = false) {
  setLanguage(lang);
  if (chosen) rememberLanguageInUrl();
  $('#lang').value = getLanguage();
  fillPresetSelect();
  fillStepSelect();
  if (S.vol) fillArchSelect();
  renderPatient();
  renderStatusWl();
  renderMessage();
  renderAbout();
  renderPrivacy();
  if (vr && !vr.failed && S.vol) applyVrLevel(Number($('#vrLevel').value));
  if (vr?.failed) vr.el.querySelector('.empty').textContent = t('err.3d', { msg: t(`err.${vr.failed}`) });
  document.querySelectorAll('.view .expand').forEach((b) => {
    b.title = t(b.closest('.view').classList.contains('maximized') ? 'collapse.title' : 'expand.title');
  });
  requestDraw();
}

function bindUi() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#preset').addEventListener('change', (e) => applyPreset(e.target.value));
  $('#lang').addEventListener('change', (e) => applyLanguage(e.target.value, true));

  $('#invert').addEventListener('click', () => {
    S.invert = !S.invert;
    $('#invert').classList.toggle('active', S.invert);
    buildLut();
  });
  $('#showCanals').addEventListener('change', (e) => { S.showCanals = e.target.checked; requestDraw(); });
  $('#showGuides').addEventListener('change', (e) => { S.showGuides = e.target.checked; requestDraw(); });
  $('#clearMeasures').addEventListener('click', () => { S.measures = []; S.angleDraft = null; requestDraw(); });
  $('#resetViews').addEventListener('click', () => {
    KINDS_2D.forEach((k) => views[k].resetView());
    if (vr && !vr.failed) { vr.reset(); vr.render(); }
    requestDraw();
  });
  $('#snapshotBtn').addEventListener('click', saveLayout);
  $('#reportBtn').addEventListener('click', createPdfReport);

  document.querySelectorAll('.view').forEach((el) => {
    el.querySelector('.expand').addEventListener('click', () => toggleMax(el));
    el.querySelector('.save').addEventListener('click', () => saveView(el.dataset.view));
  });

  $('#helpBtn').addEventListener('click', () => openCenter('guide'));
  $('#aboutBtn').addEventListener('click', () => openCenter('about'));
  $('#privacyBadge').addEventListener('click', () => openCenter('privacy'));
  $('#welcomePrivacy').addEventListener('click', () => openCenter('privacy'));
  const center = $('#center');
  center.addEventListener('click', (e) => { if (e.target === center || e.target.closest('.center-close')) closeCenter(); });
  center.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => openCenter(b.dataset.tab)));
  $('#closeScanBtn').addEventListener('click', closeScan);
  window.addEventListener('hashchange', routeHash);
  $('#aboutSource').href = REPO_URL;
  $('#aboutIssues').href = `${REPO_URL}/issues`;
  $('#aboutLicense').href = `${REPO_URL}/blob/main/LICENSE`;
  const offline = $('#offlineLink');
  if (document.documentElement.dataset.build === 'bundle' && location.protocol.startsWith('http')) {
    offline.href = location.pathname;
    offline.hidden = false;
  }

  $('#arch').addEventListener('change', (e) => selectArch(Number(e.target.value)));
  const thick = $('#panoThick');
  thick.addEventListener('input', () => {
    S.panoThick = Number(thick.value);
    $('#panoThickOut').textContent = `${S.panoThick} mm`;
    refresh();
  });
  $('#panoMode').addEventListener('change', (e) => { S.panoMode = e.target.value; refresh(); });
  $('#csWidth').addEventListener('change', (e) => { S.csWidth = Number(e.target.value); refresh(); });
  $('#csStep').addEventListener('change', (e) => { S.csStep = Number(e.target.value); });
  $('#vrPreset').addEventListener('change', (e) => applyVrPreset(e.target.value));
  $('#vrLevel').addEventListener('input', (e) => applyVrLevel(Number(e.target.value)));
  $('#series').addEventListener('change', (e) => load(e.target.value));

  const input = $('#folderInput');
  const pick = () => input.click();
  $('#openBtn').addEventListener('click', pick);
  $('#welcomeOpen').addEventListener('click', pick);
  $('#welcomeDemo').addEventListener('click', openDemo);
  input.addEventListener('change', () => {
    const entries = entriesFromInput(input.files);
    input.value = '';
    openEntries(entries);
  });

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    entriesFromDrop(e.dataTransfer).then(openEntries).catch(fail);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const hovered = S.hoverKind && views[S.hoverKind];
    if (k === 'Escape' && !$('#center').hidden) {
      closeCenter();
    } else if (k === 'Escape') {
      S.drawing = null;
      S.measuring = null;
      S.angleDraft = null;
      const max = document.querySelector('.view.maximized');
      if (max) toggleMax(max);
      requestDraw();
    } else if (k === 'Enter' && S.drawing) {
      finishArch();
    } else if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(k) && hovered) {
      e.preventDefault();
      const dir = k === 'ArrowUp' || k === 'PageUp' ? -1 : 1;
      hooks.scroll(hovered, dir, { shiftKey: e.shiftKey || k.startsWith('Page') });
    } else if (k === 'Delete' || k === 'Backspace') {
      S.measures.pop();
      requestDraw();
    } else if (k === 'f' && hovered) {
      toggleMax(hovered.el);
    } else if (k === 's' && hovered) {
      saveView(hovered.kind);
    } else if (k === 'i') {
      $('#invert').click();
    } else if (k === 'c') {
      $('#showCanals').click();
    } else if (k === 'g') {
      $('#showGuides').click();
    } else if (k === '?') {
      openCenter('guide');
    } else {
      const tool = { n: 'navigate', w: 'wl', p: 'pan', z: 'zoom', m: 'measure', l: 'angle', a: 'arch' }[k];
      if (tool) setTool(tool);
    }
  });
}

// ---------------------------------------------------------------- help centre: guide, privacy, about, terms

const TABS = ['guide', 'privacy', 'about', 'terms'];
const privacy = { blocked: 0, timer: 0 };

function setHash(tab) {
  try {
    const url = new URL(location.href);
    url.hash = tab ? `#${tab}` : '';
    history.replaceState(null, '', url);
  } catch {
    // some file:// contexts refuse history changes
  }
}

function openCenter(tab = 'guide') {
  if (!TABS.includes(tab)) tab = 'guide';
  const center = $('#center');
  center.hidden = false;
  center.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  center.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== tab; });
  center.querySelector('.center-body').scrollTop = 0;
  setHash(tab);
  clearInterval(privacy.timer);
  if (tab === 'privacy') {
    renderPrivacy();
    privacy.timer = setInterval(renderPrivacy, 1000);
  }
}

function closeCenter() {
  $('#center').hidden = true;
  clearInterval(privacy.timer);
  setHash('');
}

function routeHash() {
  const tab = location.hash.slice(1);
  if (TABS.includes(tab)) openCenter(tab);
}

function renderAbout() {
  $('#aboutVersion').textContent = t('about.version', { v: document.documentElement.dataset.version || 'dev' });
  $('#aboutCreator').textContent = t('about.creator', { name: CREATOR });
}

// The live privacy panel reports what the browser itself says about this page.
function cspActive() {
  const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '';
  return /default-src 'none'/.test(policy) && /connect-src 'none'/.test(policy);
}

function requestsAfterLoad() {
  const nav = performance.getEntriesByType('navigation')[0];
  const loaded = nav ? nav.loadEventEnd || nav.domContentLoadedEventEnd : 0;
  return performance.getEntriesByType('resource').filter((e) => /^https?:/.test(e.name) && e.startTime > loaded).length;
}

async function storedItems() {
  let n = 0;
  try { n += localStorage.length; } catch { /* blocked */ }
  try { n += sessionStorage.length; } catch { /* blocked */ }
  try { if (document.cookie) n += document.cookie.split(';').filter((c) => c.trim()).length; } catch { /* blocked */ }
  try { if (globalThis.indexedDB?.databases) n += (await indexedDB.databases()).length; } catch { /* blocked */ }
  try { if (globalThis.caches) n += (await caches.keys()).length; } catch { /* blocked */ }
  return n;
}

function setCheck(sel, ok, text) {
  const row = $(sel);
  row.classList.toggle('ok', ok);
  row.classList.toggle('warn', !ok);
  row.querySelector('.v').textContent = text;
}

async function renderPrivacy() {
  if ($('#center').hidden || $('[data-panel="privacy"]').hidden) return;
  const requests = requestsAfterLoad();
  setCheck('#chkNetwork', requests === 0, requests ? t('privacy.check.network.some', { n: requests }) : t('privacy.check.network.none'));
  const csp = cspActive();
  setCheck('#chkCsp', csp, csp ? t('privacy.check.csp.on', { n: privacy.blocked }) : t('privacy.check.csp.off'));
  const stored = await storedItems();
  setCheck('#chkStorage', stored === 0, stored ? t('privacy.check.storage.some', { n: stored }) : t('privacy.check.storage.none'));
  const mb = S.vol ? Math.round(S.vol.data.byteLength / 1048576) : 0;
  const name = S.meta?.demo ? t('patient.demo') : S.meta?.patientName || '—';
  setCheck('#chkMemory', true, S.vol ? t('privacy.check.memory.some', { name, mb }) : t('privacy.check.memory.none'));
  $('#closeScanBtn').disabled = !S.vol;
}

// Drop every reference to the scan so the browser can free it, and clear rendered pixels.
function closeScan() {
  Object.assign(S, {
    vol: null, meta: null, lut: null, series: [], arches: [], arch: null, archIdx: -1, canals: [],
    measures: [], measuring: null, drawing: null, angleDraft: null,
  });
  fillSeries();
  fillArchSelect();
  KINDS_2D.forEach((k) => {
    const vp = views[k];
    vp.setPlane(null);
    vp.sliceKey = null;
    vp.img = null;
    vp.off.width = vp.off.height = 0;
  });
  if (vr && !vr.failed) vr.clear();
  document.body.classList.remove('has-scan');
  document.title = t('app.name');
  $('#statusHover').textContent = '';
  renderPatient();
  renderStatusWl();
  setMessage('msg.closed');
  requestDraw();
  renderPrivacy();
  $('#welcomeError').hidden = true;
  $('#welcome').hidden = false;
}

// ---------------------------------------------------------------- loading

function showLoading(text, frac) {
  $('#loading').hidden = false;
  $('#loadingLabel').textContent = text;
  $('#loadingBar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
}

function hideLoading() {
  $('#loading').hidden = true;
}

function errorText(err) {
  if (err?.code) return t(`err.${err.code}`, { detail: err.detail });
  return err?.message || String(err);
}

function fail(err) {
  console.error(err);
  hideLoading();
  const text = errorText(err);
  if (S.vol) {
    S.message = { key: 'err.open', vars: () => ({ msg: errorText(err) }) };
    renderMessage();
  } else {
    $('#welcome').hidden = false;
    $('#welcomeError').hidden = false;
    $('#welcomeError').textContent = text;
  }
}

function fillSeries() {
  const sel = $('#series');
  sel.innerHTML = '';
  for (const s of S.series) sel.append(new Option(s.label, s.id));
  sel.hidden = S.series.length < 2;
}

async function load(id) {
  const entry = S.series.find((s) => s.id === id);
  if (!entry) return;
  $('#series').value = id;
  window.__viewerReady = false;
  try {
    showLoading(t('loading.read'), 0);
    const { meta, data } = await loadSeries(entry.local, (f) => showLoading(t('loading.read'), f));
    setVolume(meta, data);
  } catch (err) {
    fail(err);
  }
}

// Files picked or dropped by the user; nothing leaves the browser.
async function openEntries(entries) {
  if (!entries.length) return;
  try {
    showLoading(t('loading.scan'), 0);
    const found = await scanEntries(entries, (f) => showLoading(t('loading.scan'), f));
    S.series = found.map((s) => ({
      id: s.id,
      label: `${s.patientName || s.dir || 'Scan'} — ${s.studyDate} (${s.count})`,
      local: s,
    }));
    fillSeries();
    await load(S.series[0].id);
  } catch (err) {
    fail(err);
  }
}

async function openDemo() {
  showLoading(t('loading.demo'), 0.4);
  await new Promise((r) => setTimeout(r, 30));
  const { meta, data } = makePhantom();
  S.series = [];
  fillSeries();
  setVolume(meta, data);
}

function setVolume(meta, data) {
  const [nx, ny, nz] = meta.dims;
  const [sx, sy, sz] = meta.spacing;
  S.meta = meta;
  S.vol = { data, nx, ny, nz, sx, sy, sz, slope: meta.slope, intercept: meta.intercept, max: Math.max(meta.max, 1) };
  const an = meta.analysis;

  setCursor(an?.ortho ? an.ortho.slice() : [nx / 2, ny / 2, nz / 2]);
  S.measures = [];
  S.drawing = null;
  S.angleDraft = null;

  S.canals = (an?.canals ?? []).map((c) => ({
    name: c.name,
    radiusMm: c.radius,
    radiusVox: c.radius / sx,
    css: cssColor(c.color),
    dense: R.spline(c.points, 16),
    proj: null,
  }));

  S.arches = (an?.arches ?? []).map((a) => ({ name: a.name, type: a.type, points: a.points, demo: !!meta.demo }));
  let idx = S.arches.findIndex((a) => a.type === 'MandibularArch');
  if (idx < 0) idx = S.arches.length ? 0 : -1;

  const scanner = an?.lut ?? meta.window;
  PRESETS.scanner = scanner ? { c: scanner.center, w: scanner.width } : { c: 1048, w: 4096 };

  KINDS_2D.forEach((k) => { views[k].sliceKey = null; views[k].resetView(); });
  selectArch(idx);
  $('#preset').value = 'bone';
  applyPreset('bone');

  renderPatient();
  document.title = `${meta.demo ? t('patient.demo') : meta.patientName || 'CBCT'} – ${t('app.name')}`;
  if (meta.demo) setMessage('msg.demo');
  else if (an) setMessage('msg.loaded', { name: an.name, arches: S.arches.length, canals: S.canals.length });
  else setMessage('msg.noanalysis');

  $('#welcome').hidden = true;
  document.body.classList.add('has-scan');
  hideLoading();
  prepare3d();
}

// Built with text nodes only: values from the scan never reach innerHTML.
function renderPatient() {
  const el = $('#patient');
  el.replaceChildren();
  const m = S.meta;
  if (!m) return;
  const [nx, ny, nz] = m.dims;
  const name = document.createElement('strong');
  name.textContent = m.demo ? t('patient.demo') : m.patientName || '';
  el.append(name);
  const parts = [
    m.birthDate && t('patient.dob', { v: m.birthDate }),
    m.studyDate && t('patient.scan', { v: m.studyDate }),
    m.model,
    `${nx}×${ny}×${nz} @ ${+m.spacing[0].toFixed(3)} mm`,
  ].filter(Boolean);
  for (const part of parts) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '·';
    el.append(sep, document.createTextNode(part));
  }
}

function prepare3d() {
  if (!vr || vr.failed) { window.__viewerReady = true; return; }
  const lo = (-200 - S.vol.intercept) / S.vol.slope;
  const hi = S.meta.percentiles[1] * 1.05;
  S.vrRange = [Math.max(0, lo), Math.max(lo + 1, hi)];
  setTimeout(() => {
    vr.setVolume(S.vol, S.vrRange[0], S.vrRange[1]);
    applyVrPreset($('#vrPreset').value);
    window.__viewerReady = true;
  }, 30);
}

function start() {
  for (const kind of KINDS_2D) {
    const el = document.querySelector(`.view[data-view="${kind}"]`);
    el.style.setProperty('--accent', COLORS[kind]);
    views[kind] = new Viewport(el, kind, hooks);
  }
  const vrEl = document.querySelector('.view[data-view="vr"]');
  vrEl.style.setProperty('--accent', COLORS.vr);
  try {
    vr = new VolumeView(vrEl, { dblclick: (v) => toggleMax(v.el) });
  } catch (err) {
    console.error(err);
    vr = { failed: 'webgl', el: vrEl };
  }
  if (vr.failed) {
    vr.el = vrEl;
    vrEl.querySelector('.canvas-wrap').insertAdjacentHTML('beforeend', '<div class="empty"></div>');
  }

  for (const key of LEGACY_STORAGE_KEYS) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
  document.addEventListener('securitypolicyviolation', () => { privacy.blocked++; renderPrivacy(); });
  const langSelect = $('#lang');
  for (const l of LANGUAGES) langSelect.append(new Option(l.name, l.id));

  bindUi();
  applyLanguage(detectLanguage());
  setTool('navigate');

  if (new URLSearchParams(location.search).has('demo')) openDemo();
  else $('#welcome').hidden = false;
  routeHash();
}

start();
