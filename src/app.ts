import { Viewport } from './viewport.ts';
import type { Pos, RenderExtras, ViewHooks, ViewKind } from './viewport.ts';
import { VolumeView } from './vr.ts';
import * as R from './reslice.ts';
import type { Arch, CrossPlane, PanoCurve, PanoMode, Plane, Point, Volume } from './reslice.ts';
import { DicomError, scanEntries, loadSeries, entriesFromDrop, entriesFromInput } from './dicom.ts';
import type { Entry, ScanMeta, Series } from './dicom.ts';
import { expandArchives } from './zip.ts';
import { makePhantom } from './phantom.ts';
import { detectArch } from './autoarch.ts';
import { createReport, CSS_PER_MM, PIXEL_RATIO } from './report.ts';
import type { CrossItem, ReportInput, Tile } from './report.ts';
import { drawLogo } from './brand.ts';
import { t, setLanguage, detectLanguage, getLanguage, LANGUAGES, localeFor, rememberLanguageInUrl } from './i18n.ts';
import type { Vars } from './i18n.ts';

declare global {
  interface Window {
    __viewerReady?: boolean; // for automated checks: the scan and the 3D view are ready
  }
}

// Elements of the page itself: a missing one is a bug in index.html, so fail loudly.
function find<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
const $ = <T extends Element = HTMLElement>(sel: string) => find<T>(document, sel);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const REPO_URL = 'https://github.com/kitsorfan/dental-cbct-viewer';
const CREATOR = 'Kitsos Orfanopoulos';
const CREATOR_SITE = { url: 'https://www.kitsorfan.com', label: 'www.kitsorfan.com' };
// Real anonymized scan (CC BY 4.0), offered as a download so the page itself never connects anywhere.
const DEMO_SCAN = { url: `${REPO_URL}/releases/download/demo-data/dental-cbct-demo-kavo.zip`, size: '91 MB' };
const CROSS_STEPS = [0.5, 1, 2, 5]; // mm
const LEGACY_STORAGE_KEYS = ['dental-cbct-viewer.lang']; // written by v1.0.0, removed on start
const KINDS_2D: ViewKind[] = ['pano', 'axial', 'cross', 'coronal', 'sagittal'];
const COLORS: Record<ViewKind | 'vr' | 'measure', string> = {
  axial: '#4ea1ff', coronal: '#3fd08f', sagittal: '#ff9f43',
  pano: '#f2cf4a', cross: '#ff5fa8', vr: '#2ec4b6', measure: '#7ef0ff',
};
// [left, right, top, bottom]
const EDGE_LABELS: Record<ViewKind, string[]> = {
  axial: ['R', 'L', 'A', 'P'],
  coronal: ['R', 'L', 'S', 'I'],
  sagittal: ['A', 'P', 'S', 'I'],
  pano: ['R', 'L', 'S', 'I'],
  cross: ['edge.buccal', 'edge.lingual', 'S', 'I'],
};
const PRESETS: Record<string, { c: number; w: number }> = {
  bone: { c: 1300, w: 3000 },
  teeth: { c: 1900, w: 2600 },
  soft: { c: 150, w: 1000 },
  scanner: { c: 1048, w: 4096 },
  auto: { c: 0, w: 0 },
};
const VR_PRESETS: Record<string, { mode: number; hu?: number; level?: number }> = {
  bone: { mode: 0, hu: 800 },
  teeth: { mode: 0, hu: 2300 },
  mip: { mode: 1, hu: 400 },
  xray: { mode: 2, level: 0.3 },
};
const TOOL_KEYS: Record<string, string> = { n: 'navigate', k: 'scroll', w: 'wl', p: 'pan', z: 'zoom', m: 'measure', l: 'angle', a: 'arch' };

// A scan's voxels with what is needed to turn them into Hounsfield units.
interface ScanVolume extends Volume {
  slope: number;
  intercept: number;
  max: number;
}

// half: on a cross-section, the plane's half-width when the measurement was drawn, so that a
// later width change keeps it on the same anatomy.
interface Distance {
  type: 'distance';
  kind: ViewKind;
  key: string | null;
  a: number[];
  b: number[];
  sx: number;
  sy: number;
  half?: number;
}

interface Angle {
  type: 'angle';
  kind: ViewKind;
  key: string | null;
  pts: number[][];
  sx: number;
  sy: number;
  half?: number;
}

type Measure = Distance | Angle;

interface ArchEntry {
  type: string;
  points: Point[];
  name?: string;
  demo?: boolean;
  auto?: boolean;
  custom?: number;
  built?: Arch;
}

interface Canal {
  name: string;
  radiusMm: number;
  radiusVox: number;
  css: string;
  dense: Point[];
  proj: (number[] | null)[] | null;
}

interface State {
  series: { id: string; label: string; local: Series }[];
  meta: ScanMeta | null;
  vol: ScanVolume | null;
  cursor: number[];
  wl: { c: number; w: number };
  invert: boolean;
  lut: Uint32Array | null;
  tool: string;
  showCanals: boolean;
  showGuides: boolean;
  arches: ArchEntry[];
  archIdx: number;
  arch: Arch | null;
  panoOffset: number;
  panoThick: number;
  panoMode: PanoMode;
  csIndex: number;
  csMm: number;
  csStep: number;
  csWidth: number;
  canals: Canal[];
  measures: Measure[];
  measuring: Distance | null;
  angleDraft: Angle | null;
  angleHover: number[] | null;
  drawing: Point[] | null;
  drawHover: Pos | null;
  hoverKind: ViewKind | null;
  vrRange: number[];
  message: { key: string; vars: Vars | (() => Vars) } | null;
  // Where the scan opened; Reset returns there. frontZ: the opening cursor sits on the
  // front of a found arch at this height (set once that arch is built).
  start: { cursor: number[]; archIdx: number; frontZ: number | null } | null;
}

// View settings every scan opens with.
const DEFAULTS = { panoThick: 8, panoMode: 'avg' as PanoMode, csStep: 1, csWidth: 40 };

const S: State = {
  series: [],
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
  ...DEFAULTS,
  csIndex: 0,
  csMm: 0,
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
  start: null,
};

const views = {} as Record<ViewKind, Viewport>;
let vr: VolumeView | null = null;

// ---------------------------------------------------------------- rendering loop

const dirty = new Set<ViewKind>();
let frame = 0;

function requestDraw(kind?: ViewKind) {
  if (kind) dirty.add(kind);
  else KINDS_2D.forEach((k) => dirty.add(k));
  if (!frame) frame = requestAnimationFrame(drawAll);
}

function drawAll() {
  frame = 0;
  for (const k of dirty) views[k].draw(S.lut);
  dirty.clear();
}

// The open scan, for code that only runs while one is open.
function volume(): ScanVolume {
  if (!S.vol) throw new Error('No scan is open');
  return S.vol;
}

const mm = (v: number) => v / volume().sx;
const rounded = () => S.cursor.map((v) => Math.round(v));

// The panoramic's curve for the current arch and buccal/lingual offset.
let curveMemo: { arch: Arch; offset: number; curve: PanoCurve } | null = null;
function panoCurve(): PanoCurve | null {
  const arch = S.arch;
  if (!arch) return null;
  if (curveMemo?.arch !== arch || curveMemo.offset !== S.panoOffset) {
    curveMemo = { arch, offset: S.panoOffset, curve: R.panoCurve(arch, mm(S.panoOffset)) };
  }
  return curveMemo.curve;
}

// The panoramic column over a (fractional) arch sample.
function panoColumn(at: number) {
  const curve = panoCurve();
  return curve ? R.panoColumn(curve, at) : at;
}

// Where a measurement drawn on an earlier cross-section width sits on the current one.
function crossShift(vp: Viewport, m: { half?: number }) {
  return vp.kind === 'cross' && m.half !== undefined && vp.plane ? (vp.plane as CrossPlane).half - m.half : 0;
}

const crossHalf = (vp: Viewport) => (vp.kind === 'cross' && vp.plane ? (vp.plane as CrossPlane).half : undefined);

interface PlaneSource {
  key: string; // what is shown
  mkey: string; // which measurements belong to it
  make: () => Plane | null;
}

function planeFor(kind: ViewKind): PlaneSource {
  const vol = volume();
  const arch = S.arch;
  const [ix, iy, iz] = rounded();
  switch (kind) {
    case 'axial': return { key: `a${iz}`, mkey: `a${iz}`, make: () => R.axial(vol, iz) };
    case 'coronal': return { key: `c${iy}`, mkey: `c${iy}`, make: () => R.coronal(vol, iy) };
    case 'sagittal': return { key: `s${ix}`, mkey: `s${ix}`, make: () => R.sagittal(vol, ix) };
    case 'pano': {
      const curve = panoCurve();
      if (!curve) return { key: 'none', mkey: 'none', make: () => null };
      const mkey = `p${S.archIdx}:${S.panoOffset}`;
      return {
        key: `${mkey}:${S.panoThick}:${S.panoMode}`, mkey,
        make: () => R.panoramic(vol, curve, mm(S.panoThick), S.panoMode),
      };
    }
    case 'cross': {
      if (!arch) return { key: 'none', mkey: 'none', make: () => null };
      const mkey = `x${S.archIdx}:${S.csMm.toFixed(3)}:${S.panoOffset}`;
      return {
        key: `${mkey}:${S.csWidth}`, mkey,
        make: () => R.crossSection(vol, arch, S.csIndex, mm(S.panoOffset), mm(S.csWidth), 1),
      };
    }
  }
}

function reslice(kind: ViewKind) {
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

function imageToVoxel(kind: ViewKind, u: number, v: number, plane: Plane | null): number[] | null {
  const { nz } = volume();
  const iu = u - 0.5, iv = v - 0.5;
  const z = nz - 1 - iv;
  switch (kind) {
    case 'axial': return [iu, iv, S.cursor[2]];
    case 'coronal': return [iu, S.cursor[1], z];
    case 'sagittal': return [S.cursor[0], iu, z];
    case 'pano': {
      const c = panoCurve();
      if (!c) return null;
      const j = clamp(Math.round(iu), 0, c.M - 1);
      return [c.x[j], c.y[j], z, c.at[j]];
    }
    case 'cross': {
      const p = plane as CrossPlane | null;
      if (!p) return null;
      const d = p.half - iu;
      return [p.cx + d * p.nx, p.cy + d * p.ny, z];
    }
  }
}

function setCursor(p: number[]) {
  const { nx, ny, nz } = volume();
  S.cursor = [clamp(p[0], 0, nx - 1), clamp(p[1], 0, ny - 1), clamp(p[2], 0, nz - 1)];
}

// The cross-section position is kept in millimetres along the arch, so stepping by 1 mm never
// drifts; it need not fall on an arch sample.
function setCross(index: number) {
  setCrossMm(index * volume().sx);
}

function setCrossMm(value: number) {
  if (!S.arch) return;
  const { sx } = volume();
  S.csMm = Math.round(clamp(value, 0, (S.arch.M - 1) * sx) * 1e6) / 1e6;
  S.csIndex = S.csMm / sx;
}

function navigate(vp: Viewport, u: number, v: number) {
  const p = imageToVoxel(vp.kind, u, v, vp.plane);
  if (!p) return;
  setCursor(p);
  if (vp.kind === 'pano') setCross(p[3]);
  if (vp.kind === 'axial' && S.arch) {
    const near = R.nearestOnArch(S.arch, p[0], p[1]);
    if (near.dist * volume().sx < 15) setCross(near.index);
  }
  refresh();
}

// ---------------------------------------------------------------- interaction hooks

const hooks: ViewHooks = {
  invalidate: (vp) => requestDraw(vp.kind),
  tool: () => S.tool,
  windowLevel(dx, dy) {
    const k = Math.max(1, S.wl.w / 300);
    S.wl.w = clamp(S.wl.w + dx * k, 20, 20000);
    S.wl.c += dy * k;
    $<HTMLSelectElement>('#preset').value = 'custom';
    buildLut();
  },
  // Returns how to undo the action, for when a second finger turns the gesture into a pinch.
  dragStart(vp, mode, pos) {
    const plane = vp.plane;
    if (!plane) return null;
    const inside = vp.inside(pos.u, pos.v);
    if (mode === 'navigate') {
      const before = { cursor: S.cursor.slice(), csIndex: S.csIndex, csMm: S.csMm };
      navigate(vp, pos.u, pos.v);
      return () => { Object.assign(S, before); refresh(); };
    } else if (mode === 'measure' && inside) {
      S.measuring = { type: 'distance', kind: vp.kind, key: vp.measureKey, a: [pos.u, pos.v], b: [pos.u, pos.v], sx: plane.sx, sy: plane.sy, half: crossHalf(vp) };
      return () => { S.measuring = null; requestDraw(vp.kind); };
    } else if (mode === 'angle' && inside) {
      const d = S.angleDraft;
      if (!d || d.kind !== vp.kind || d.key !== vp.measureKey) {
        S.angleDraft = { type: 'angle', kind: vp.kind, key: vp.measureKey, pts: [[pos.u, pos.v]], sx: plane.sx, sy: plane.sy, half: crossHalf(vp) };
        requestDraw(vp.kind);
        return () => { S.angleDraft = d; requestDraw(); };
      }
      d.pts.push([pos.u - crossShift(vp, d), pos.v]);
      if (d.pts.length === 3) {
        S.measures.push(d);
        S.angleDraft = null;
      }
      requestDraw(vp.kind);
      return () => {
        if (S.measures[S.measures.length - 1] === d) S.measures.pop();
        d.pts.pop();
        S.angleDraft = d;
        requestDraw(vp.kind);
      };
    } else if (mode === 'arch' && vp.kind === 'axial' && inside) {
      const fresh = !S.drawing;
      S.drawing = S.drawing || [];
      S.drawing.push([pos.u - 0.5, pos.v - 0.5, S.cursor[2]]);
      requestDraw('axial');
      return () => {
        S.drawing?.pop();
        if (fresh) S.drawing = null;
        requestDraw('axial');
      };
    } else if (mode === 'arch' && vp.kind !== 'axial') {
      setMessage('msg.arch.axial');
    }
    return null;
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
  // A lifted finger leaves its last reading in the status bar; a mouse that leaves clears it.
  hover(vp, pos, lifted = false) {
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
    if (!pos && lifted) return;
    const p = vp.plane;
    if (!pos || !S.vol || !p || !vp.inside(pos.u, pos.v)) { el.textContent = ''; return; }
    const raw = p.data[Math.floor(pos.v) * p.w + Math.floor(pos.u)];
    const hu = Math.round(raw * S.vol.slope + S.vol.intercept);
    const vox = imageToVoxel(vp.kind, pos.u, pos.v, p);
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
    if (vp.el) toggleMax(vp.el);
  },
  overlay: drawOverlay,
};

function distanceMm(m: Distance) {
  return Math.hypot((m.b[0] - m.a[0]) * m.sx, (m.b[1] - m.a[1]) * m.sy);
}

function angleDeg(pts: number[][], sx: number, sy: number) {
  const [a, b, c] = pts;
  const ux = (a[0] - b[0]) * sx, uy = (a[1] - b[1]) * sy;
  const vx = (c[0] - b[0]) * sx, vy = (c[1] - b[1]) * sy;
  const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
  return (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI;
}

function measureValue(m: Measure) {
  return m.type === 'angle' ? `${angleDeg(m.pts, m.sx, m.sy).toFixed(1)}°` : `${distanceMm(m).toFixed(2)} mm`;
}

// View controls that do not fit beside the title go to a second line rather than being cut off.
function fitControls() {
  for (const head of document.querySelectorAll<HTMLElement>('.vhead')) {
    const ctl = head.querySelector('.vctl');
    if (!ctl || !head.offsetParent) continue;
    head.classList.remove('stacked');
    head.classList.toggle('stacked', ctl.scrollWidth > ctl.clientWidth + 1);
  }
}

// Maximise one view, or restore the grid when it is already maximised.
function toggleMax(el: HTMLElement) {
  const grid = $('#grid');
  const on = !el.classList.contains('maximized');
  document.querySelectorAll('.view.maximized').forEach((v) => v.classList.remove('maximized'));
  grid.classList.toggle('max', on);
  document.body.classList.toggle('expanded', on); // phones also fold the toolbar away
  if (on) el.classList.add('maximized');
  setExpandTitles();
}

function setExpandTitles() {
  document.querySelectorAll<HTMLElement>('.view .expand').forEach((b) => {
    b.title = t(b.closest('.view')?.classList.contains('maximized') ? 'collapse.title' : 'expand.title');
  });
}

// ---------------------------------------------------------------- arches & canals

function selectArch(idx: number) {
  S.archIdx = idx;
  const entry = S.arches[idx];
  const arch = S.arch = entry ? (entry.built ||= R.buildArch(entry.points)) : null;
  S.panoOffset = 0;
  setCross(arch ? Math.floor(arch.M / 2) : 0);
  for (const c of S.canals) {
    if (!arch) { c.proj = null; continue; }
    c.proj = c.dense.map((p) => {
      const n = R.nearestOnArch(arch, p[0], p[1]);
      return n.index === 0 || n.index === arch.M - 1 ? null : [n.index, p[2]];
    });
  }
  fillArchSelect();
  refresh();
}

function archName(a: ArchEntry) {
  if (a.custom) return t('arch.custom', { n: a.custom });
  if (a.auto) return t('arch.auto');
  return a.demo ? t('arch.demo') : a.name ?? '';
}

function fillArchSelect() {
  const sel = $<HTMLSelectElement>('#arch');
  sel.innerHTML = '';
  if (!S.arches.length) {
    sel.append(new Option(t('arch.none'), '-1'));
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  S.arches.forEach((a, i) => sel.append(new Option(archName(a), String(i))));
  sel.value = String(S.archIdx);
  fitControls();
}

function finishArch() {
  const pts: Point[] = [];
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

function cssColor(rgb: number[], alpha = 1) {
  return `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${alpha})`;
}

// ---------------------------------------------------------------- overlay drawing

type Ctx = CanvasRenderingContext2D;

function path(ctx: Ctx, pts: number[][], color: string, width: number, { dash = [] as number[], alpha = 1 } = {}) {
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

function ring(ctx: Ctx, [x, y]: number[], r: number, color: string) {
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

function dot(ctx: Ctx, [x, y]: number[], color: string, r = 3) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

interface LabelStyle {
  color?: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  bg?: string | null;
  size?: number;
  weight?: number;
}

function label(ctx: Ctx, str: string, x: number, y: number,
  { color = '#e8edf3', align = 'left', baseline = 'alphabetic', bg = null, size = 12, weight = 500 }: LabelStyle = {}) {
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

function crosshair(vp: Viewport, ctx: Ctx, X: number, Y: number, vColor: string, hColor: string) {
  if (!vp.plane) return;
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
function drawOverlay(vp: Viewport, ctx: Ctx) {
  const kind = vp.kind;
  const info = vp.el?.querySelector('.vinfo');
  const setInfo = (s: string) => { if (info) info.textContent = s; };
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
  const P = (x: number, y: number) => vp.toScreen(x + 0.5, y + 0.5);
  const Z = (z: number) => nz - 1 - z;
  const a = S.arch;

  if (kind === 'axial') {
    if (guides && a) {
      const off = mm(S.panoOffset);
      const curve = (d: number) => {
        const pts: number[][] = [];
        for (let i = 0; i < a.M; i += 2) pts.push(P(a.x[i] + d * a.nx[i], a.y[i] + d * a.ny[i]));
        return pts;
      };
      path(ctx, curve(off), COLORS.pano, 1.5, { alpha: 0.85 });
      const half = mm(S.panoThick) / 2;
      if (half > 1) {
        path(ctx, curve(off - half), COLORS.pano, 1, { dash: [4, 4], alpha: 0.45 });
        path(ctx, curve(off + half), COLORS.pano, 1, { dash: [4, 4], alpha: 0.45 });
      }
      const cp = views.cross.plane as CrossPlane | null;
      if (cp) {
        const A = P(cp.cx + cp.half * cp.nx, cp.cy + cp.half * cp.ny);
        const B = P(cp.cx - cp.half * cp.nx, cp.cy - cp.half * cp.ny);
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
        const segs: number[][][] = [];
        let cur: number[][] = [];
        for (const pr of c.proj) {
          if (!pr) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
          cur.push(P(panoColumn(pr[0]), Z(pr[1])));
        }
        if (cur.length > 1) segs.push(cur);
        for (const seg of segs) {
          path(ctx, seg, c.css, 2 * c.radiusMm * vp.cssPerMm, { alpha: 0.32 });
          path(ctx, seg, c.css, 1.2, { alpha: 0.95 });
        }
      }
    }
    if (guides) {
      const [X, Y] = P(panoColumn(S.csIndex), Z(S.cursor[2]));
      crosshair(vp, ctx, X, Y, COLORS.cross, COLORS.axial);
    }
    const ticks = vp.report?.ticks ?? [];
    if (ticks.length) {
      const [, top] = vp.toScreen(0, 0);
      const [, bottom] = vp.toScreen(0, vp.plane.h);
      const [x0] = P(panoColumn(ticks[0].index), 0);
      const [x1] = P(panoColumn(ticks[ticks.length - 1].index), 0);
      ctx.save();
      ctx.fillStyle = 'rgba(255, 95, 168, 0.14)';
      ctx.fillRect(Math.min(x0, x1) - 2, top, Math.abs(x1 - x0) + 4, bottom - top);
      ctx.restore();
      const spacing = ticks.length > 1 ? Math.abs(x1 - x0) / (ticks.length - 1) : 99;
      const every = Math.max(1, Math.ceil(24 / spacing));
      const dense = ticks.length > 16;
      ticks.forEach((tick, k) => {
        const [X] = P(panoColumn(tick.index), 0);
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

  if (kind === 'cross' && a) {
    const cp = vp.plane as CrossPlane;
    if (S.showCanals) {
      const f = (p: Point) => (p[0] - cp.cx) * cp.tx + (p[1] - cp.cy) * cp.ty;
      for (const c of S.canals) {
        for (const q of R.crossings(c.dense, f)) {
          const d = (q[0] - cp.cx) * cp.nx + (q[1] - cp.cy) * cp.ny;
          if (Math.abs(d) > cp.half) continue;
          ring(ctx, P(cp.half - d, Z(q[2])), c.radiusVox * vp.kx, c.css);
        }
      }
    }
    if (guides) {
      const [X, Y] = P(cp.half, Z(S.cursor[2]));
      crosshair(vp, ctx, X, Y, COLORS.pano, COLORS.axial);
    }
    setInfo(t('info.along', { pos: (cp.index * S.vol.sx).toFixed(1), len: (a.length * S.vol.sx).toFixed(1) }));
  }

  drawMeasures(vp, ctx);
  drawEdgeLabels(vp, ctx);
  drawScaleBar(vp, ctx);
}

function drawMeasures(vp: Viewport, ctx: Ctx) {
  const list: Measure[] = S.measures.filter((m) => m.kind === vp.kind && m.key === vp.measureKey);
  if (!vp.report && S.measuring && S.measuring.kind === vp.kind) list.push(S.measuring);
  list.forEach((m) => {
    const n = S.measures.indexOf(m) + 1;
    const tag = vp.report && n ? `${n}: ` : '';
    if (m.type === 'angle') drawAngle(vp, ctx, m.pts, m, tag);
    else drawDistance(vp, ctx, m, tag);
  });
  const d = S.angleDraft;
  if (!vp.report && d && d.kind === vp.kind && d.key === vp.measureKey) {
    const pts = S.angleHover ? [...d.pts, [S.angleHover[0] - crossShift(vp, d), S.angleHover[1]]] : d.pts;
    drawAngle(vp, ctx, pts, d, '');
  }
}

function drawDistance(vp: Viewport, ctx: Ctx, m: Distance, tag: string) {
  const du = crossShift(vp, m);
  const A = vp.toScreen(m.a[0] + du, m.a[1]), B = vp.toScreen(m.b[0] + du, m.b[1]);
  path(ctx, [A, B], COLORS.measure, 2);
  dot(ctx, A, COLORS.measure);
  dot(ctx, B, COLORS.measure);
  const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
  label(ctx, `${tag}${distanceMm(m).toFixed(2)} mm`, mx + 8, my - 8, { color: '#0b1016', bg: COLORS.measure, size: 12, weight: 700 });
}

function drawAngle(vp: Viewport, ctx: Ctx, pts: number[][], m: Angle, tag: string) {
  const du = crossShift(vp, m);
  const P = pts.map((p) => vp.toScreen(p[0] + du, p[1]));
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

function drawEdgeLabels(vp: Viewport, ctx: Ctx) {
  const compact = vp.report?.compact;
  const [l, r, top, b] = EDGE_LABELS[vp.kind].map((s) => (s.includes('.') ? t(compact ? `${s}.short` : s) : s));
  const o: LabelStyle = { color: 'rgba(232, 237, 243, 0.75)', size: compact ? 10 : 12, weight: 700 };
  label(ctx, l, 6, vp.cssH / 2, { ...o, baseline: 'middle' });
  label(ctx, r, vp.cssW - 6, vp.cssH / 2, { ...o, align: 'right', baseline: 'middle' });
  if (vp.report?.ticks) return;
  label(ctx, top, vp.cssW / 2, 6, { ...o, align: 'center', baseline: 'top' });
  label(ctx, b, vp.cssW / 2, vp.cssH - 6, { ...o, align: 'center' });
}

function drawScaleBar(vp: Viewport, ctx: Ctx) {
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
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fileStem() {
  const name = S.meta?.demo ? 'demo' : (S.meta?.patientName || 'scan');
  return name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'scan';
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const canvasBlob = (canvas: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));

async function saveView(kind: ViewKind | 'vr') {
  if (!S.vol) return;
  let canvas: HTMLCanvasElement;
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
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0a0d11';
  ctx.fillRect(0, 0, grid.width, grid.height + strip);
  drawLogo(ctx, 10, 8, 24);
  label(ctx, t('app.name'), 42, 25, { size: 15, weight: 700, color: '#e6edf3' });
  label(ctx, patientLine(), grid.width - 12, 25, { size: 13, align: 'right', color: '#aab6c3' });
  for (const el of document.querySelectorAll<HTMLElement>('#grid > .view')) {
    if (!el.offsetParent) continue;
    const kind = el.dataset.view as ViewKind | 'vr';
    const r = el.getBoundingClientRect();
    const x = r.left - grid.left, y = r.top - grid.top + strip;
    const head = find(el, '.vhead').getBoundingClientRect();
    const wrap = find(el, '.canvas-wrap').getBoundingClientRect();
    ctx.fillStyle = '#11161c';
    ctx.fillRect(x, y, r.width, head.height);
    dot(ctx, [x + 13, y + head.height / 2], COLORS[kind], 4.5);
    const info = find(el, '.vinfo').textContent;
    label(ctx, `${t(`view.${kind}`)}${info ? `   ${info}` : ''}`, x + 24, y + head.height / 2, { baseline: 'middle', size: 12, weight: 600 });
    const source = kind === 'vr' ? vr?.canvas : views[kind].canvas;
    if (source) ctx.drawImage(source, x + (wrap.left - r.left), y + (wrap.top - r.top), wrap.width, wrap.height);
  }
  const blob = await canvasBlob(canvas);
  if (blob) download(blob, `${fileStem()}-views-${stamp()}.png`);
}

// Off-screen render of a plane at a physical size for the report.
function renderPlane(kind: ViewKind, plane: Plane, wMm: number, hMm: number, extra: RenderExtras = {}) {
  const vp = new Viewport(null, kind, { ...hooks, invalidate() {} },
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
  const vol = S.vol, m = S.meta;
  if (!vol || !m) return;
  showLoading(t('report.creating'), 0.2);
  await new Promise((r) => setTimeout(r, 30));
  try {
    const { nx, ny, nz, sx, sy, sz } = vol;
    const now = new Date();
    const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, ''));
    const info: [string, string][] = [
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
    const axial = R.axial(vol, iz);
    const physical = (p: Plane) => (p.w * p.sx) / (p.h * p.sy);
    const panoPlane = views.pano.plane;
    const pano: ReportInput['pano'] = panoPlane && {
      title: t('view.pano'),
      subtitle: [S.arches[S.archIdx] && archName(S.arches[S.archIdx]), `${S.panoThick} mm`].filter(Boolean).join(' · '),
      aspect: physical(panoPlane),
      render: (w, h, extra = {}) => renderPlane('pano', panoPlane, w, h, { ...extra, measureKey: extra.ticks ? null : views.pano.measureKey }),
    };

    const tiles: Tile[] = [];
    if (vr && !vr.failed && vr.ready) {
      const view = vr;
      tiles.push({ title: t('view.vr'), subtitle: $<HTMLSelectElement>('#vrPreset').selectedOptions[0]?.textContent ?? '',
        render: (w, h) => view.snapshot(w * CSS_PER_MM * PIXEL_RATIO, h * CSS_PER_MM * PIXEL_RATIO) });
    }
    tiles.push({ title: t('view.axial'), subtitle: t('info.slice', { n: iz + 1, total: nz }),
      render: (w, h) => renderPlane('axial', axial, w, h, { measureKey: `a${iz}`, slice: [ix, iy, iz] }) });
    if (!pano) {
      tiles.push({ title: t('view.coronal'), render: (w, h) => renderPlane('coronal', R.coronal(vol, iy), w, h, { measureKey: `c${iy}`, slice: [ix, iy, iz] }) });
      tiles.push({ title: t('view.sagittal'), render: (w, h) => renderPlane('sagittal', R.sagittal(vol, ix), w, h, { measureKey: `s${ix}`, slice: [ix, iy, iz] }) });
    }

    // Serial cross-sections every S.csStep mm along the whole arch (1 mm by default).
    let cross: ReportInput['cross'] = null;
    if (pano && S.arch) {
      const a = S.arch;
      const step = S.csStep;
      const lengthMm = (a.M - 1) * sx;
      const first = Math.ceil(2 / step) * step;
      const fmt = (v: number) => v.toFixed(step < 1 ? 1 : 0);
      const items: CrossItem[] = [];
      for (let k = 0; first + k * step <= lengthMm - 2 + 1e-6 && items.length < 400; k++) {
        const pos = first + k * step;
        items.push({ index: pos / sx, label: k + 1, detail: `${fmt(pos)} mm` });
      }
      if (items.length) {
        const plane = (it: CrossItem) => R.crossSection(vol, a, it.index, mm(S.panoOffset), mm(S.csWidth), 1);
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

    const viewTiles = (['axial', 'cross', 'coronal', 'sagittal'] as ViewKind[])
      .filter((k) => views[k].plane)
      .map((k): Tile => ({
        title: t(`view.${k}`),
        subtitle: views[k].el?.querySelector('.vinfo')?.textContent ?? '',
        render: (w, h) => renderPlane(k, views[k].plane!, w, h, { measureKey: views[k].measureKey, slice: [ix, iy, iz] }),
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
    setMessage('err.report', { msg: errorText(err) });
  } finally {
    hideLoading();
    refresh();
    if (vr && !vr.failed) vr.render();
  }
}

// ---------------------------------------------------------------- UI wiring

function setMessage(key: string | null, vars: Vars | (() => Vars) = {}) {
  S.message = key ? { key, vars } : null;
  renderMessage();
}

function renderMessage() {
  const m = S.message;
  $('#statusMsg').textContent = m ? t(m.key, typeof m.vars === 'function' ? m.vars() : m.vars) : '';
}

// Phones and tablets without a mouse: tap wording, ZIP-first opening, touch help first.
const touchOnly = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
const TOOL_MESSAGES = ['msg.arch.draw', 'msg.arch.tap', 'msg.angle', 'msg.angle.tap', 'msg.arch.axial'];

function setTool(tool: string) {
  S.tool = tool;
  document.querySelectorAll<HTMLElement>('button[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  document.body.dataset.tool = tool;
  if (tool !== 'arch' && S.drawing) {
    S.drawing = null;
    requestDraw('axial');
  }
  if (tool !== 'angle' && S.angleDraft) {
    S.angleDraft = null;
    requestDraw();
  }
  if (tool === 'arch') {
    revealView('axial');
    setMessage(touchOnly() ? 'msg.arch.tap' : 'msg.arch.draw');
  } else if (tool === 'angle') {
    setMessage(touchOnly() ? 'msg.angle.tap' : 'msg.angle');
  } else if (S.message && TOOL_MESSAGES.includes(S.message.key)) {
    setMessage(null);
  }
}

// Phones show the panoramic and one other view; this picks the other one.
function showSecond(kind: string) {
  $('#grid').dataset.second = kind;
  document.querySelectorAll<HTMLElement>('#viewtabs [data-show]').forEach((b) => {
    const on = b.dataset.show === kind;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
}

function setMenu(open: boolean) {
  $('#topbar').classList.toggle('open', open);
  $('#moreBtn').setAttribute('aria-expanded', String(open));
}

// Make sure a view is on screen: leave another view's full-window mode, pick its phone tab.
function revealView(kind: string) {
  const el = $(`.view[data-view="${kind}"]`);
  const max = document.querySelector<HTMLElement>('.view.maximized');
  if (max && max !== el) toggleMax(max);
  if (!el.offsetParent) showSecond(kind);
}

function fillPresetSelect() {
  const preset = $<HTMLSelectElement>('#preset');
  const value = preset.value;
  preset.innerHTML = '';
  for (const id of Object.keys(PRESETS)) preset.append(new Option(t(`preset.${id}`), id));
  preset.append(new Option(t('preset.custom'), 'custom'));
  preset.value = value || 'bone';
}

function applyPreset(id: string) {
  const p = PRESETS[id];
  const vol = S.vol;
  if (!p || !vol || !S.meta) return;
  if (id === 'auto') {
    const [lo, hi] = S.meta.percentiles.map((v) => v * vol.slope + vol.intercept);
    S.wl = { c: (lo + hi) / 2, w: Math.max(50, hi - lo) };
  } else {
    S.wl = { c: p.c, w: p.w };
  }
  buildLut();
}

function vrHu(level: number) {
  const [lo, hi] = S.vrRange;
  const { slope, intercept } = volume();
  return (lo + level * (hi - lo)) * slope + intercept;
}

function vrLevel(hu: number) {
  const [lo, hi] = S.vrRange;
  const { slope, intercept } = volume();
  return clamp(((hu - intercept) / slope - lo) / (hi - lo), 0, 1);
}

function applyVrPreset(id: string) {
  if (!vr || vr.failed || !S.vol) return;
  const p = VR_PRESETS[id];
  vr.mode = p.mode;
  const level = p.level ?? vrLevel(p.hu ?? 0);
  $<HTMLInputElement>('#vrLevel').value = String(level);
  applyVrLevel(level);
  fitControls();
}

function applyVrLevel(level: number) {
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
  const sel = $<HTMLSelectElement>('#csStep');
  sel.innerHTML = '';
  for (const v of CROSS_STEPS) sel.append(new Option(t('cs.step', { v }), String(v)));
  sel.value = String(S.csStep);
}

function applyLanguage(lang: string, chosen = false) {
  setLanguage(lang);
  if (chosen) rememberLanguageInUrl();
  $<HTMLSelectElement>('#lang').value = getLanguage();
  fillPresetSelect();
  fillStepSelect();
  if (S.vol) fillArchSelect();
  renderPatient();
  renderStatusWl();
  renderMessage();
  renderAbout();
  renderPrivacy();
  if (vr && !vr.failed && S.vol) applyVrLevel(Number($<HTMLInputElement>('#vrLevel').value));
  if (vr?.failed) find(vr.el, '.empty').textContent = t('err.3d', { msg: t(`err.${vr.failed}`) });
  setExpandTitles();
  fitControls();
  requestDraw();
}

function bindUi() {
  document.querySelectorAll<HTMLElement>('button[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool ?? 'navigate')));
  const preset = $<HTMLSelectElement>('#preset');
  preset.addEventListener('change', () => applyPreset(preset.value));
  const lang = $<HTMLSelectElement>('#lang');
  lang.addEventListener('change', () => applyLanguage(lang.value, true));

  $('#invert').addEventListener('click', () => {
    S.invert = !S.invert;
    $('#invert').classList.toggle('active', S.invert);
    buildLut();
  });
  const canals = $<HTMLInputElement>('#showCanals');
  canals.addEventListener('change', () => { S.showCanals = canals.checked; requestDraw(); });
  const guides = $<HTMLInputElement>('#showGuides');
  guides.addEventListener('change', () => { S.showGuides = guides.checked; requestDraw(); });
  $('#clearMeasures').addEventListener('click', () => { S.measures = []; S.angleDraft = null; requestDraw(); });
  $('#resetViews').addEventListener('click', () => {
    const work = S.measures.length > 0 || S.arches.some((a) => a.custom);
    if (work && !confirm(t('reset.confirm'))) return;
    restoreOpeningState();
  });
  $('#snapshotBtn').addEventListener('click', saveLayout);
  $('#reportBtn').addEventListener('click', createPdfReport);

  document.querySelectorAll<HTMLElement>('.view').forEach((el) => {
    find(el, '.expand').addEventListener('click', () => toggleMax(el));
    find(el, '.save').addEventListener('click', () => saveView(el.dataset.view as ViewKind | 'vr'));
  });
  document.querySelectorAll<HTMLElement>('#viewtabs [data-show]').forEach((b) => b.addEventListener('click', () => {
    const max = document.querySelector<HTMLElement>('.view.maximized');
    if (max) toggleMax(max);
    showSecond(b.dataset.show ?? 'cross');
  }));

  // The ⋯ menu on narrow screens closes after an action, or a tap anywhere else.
  const topbar = $('#topbar');
  const more = $('#more');
  const target = (e: Event) => (e.target instanceof Element ? e.target : null);
  more.addEventListener('click', (e) => { if (target(e)?.closest('button')) setMenu(false); });
  more.addEventListener('change', (e) => { if (target(e)?.matches('select')) setMenu(false); });
  $('#moreBtn').addEventListener('click', () => setMenu(!topbar.classList.contains('open')));
  document.addEventListener('pointerdown', (e) => {
    if (topbar.classList.contains('open') && !target(e)?.closest('#more, #moreBtn')) setMenu(false);
  });

  $('#helpBtn').addEventListener('click', () => openCenter('guide'));
  $('#aboutBtn').addEventListener('click', () => openCenter('about'));
  $('#privacyBadge').addEventListener('click', () => openCenter('privacy'));
  $('#welcomePrivacy').addEventListener('click', () => openCenter('privacy'));
  const center = $('#center');
  center.addEventListener('click', (e) => { if (e.target === center || target(e)?.closest('.center-close')) closeCenter(); });
  center.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => openCenter(b.dataset.tab)));
  $('#closeScanBtn').addEventListener('click', closeScan);
  window.addEventListener('hashchange', routeHash);
  $<HTMLAnchorElement>('#aboutSource').href = REPO_URL;
  $<HTMLAnchorElement>('#aboutIssues').href = `${REPO_URL}/issues`;
  $<HTMLAnchorElement>('#aboutLicense').href = `${REPO_URL}/blob/main/LICENSE`;
  const offline = $<HTMLAnchorElement>('#offlineLink');
  if (document.documentElement.dataset.build === 'bundle' && location.protocol.startsWith('http')) {
    offline.href = location.pathname;
    offline.hidden = false;
  }

  const arch = $<HTMLSelectElement>('#arch');
  arch.addEventListener('change', () => selectArch(Number(arch.value)));
  const thick = $<HTMLInputElement>('#panoThick');
  thick.addEventListener('input', () => {
    S.panoThick = Number(thick.value);
    $('#panoThickOut').textContent = `${S.panoThick} mm`;
    refresh();
  });
  const panoMode = $<HTMLSelectElement>('#panoMode');
  panoMode.addEventListener('change', () => { S.panoMode = panoMode.value as PanoMode; refresh(); });
  const csWidth = $<HTMLSelectElement>('#csWidth');
  csWidth.addEventListener('change', () => { S.csWidth = Number(csWidth.value); refresh(); });
  const csStep = $<HTMLSelectElement>('#csStep');
  csStep.addEventListener('change', () => { S.csStep = Number(csStep.value); });
  const vrPreset = $<HTMLSelectElement>('#vrPreset');
  vrPreset.addEventListener('change', () => applyVrPreset(vrPreset.value));
  const vrLevelInput = $<HTMLInputElement>('#vrLevel');
  vrLevelInput.addEventListener('input', () => applyVrLevel(Number(vrLevelInput.value)));
  const series = $<HTMLSelectElement>('#series');
  series.addEventListener('change', () => load(series.value));

  // A folder on computers; on phones the scan usually arrives as a ZIP, and older ones cannot pick folders.
  const folder = $<HTMLInputElement>('#folderInput');
  const files = $<HTMLInputElement>('#fileInput');
  $('#openBtn').addEventListener('click', () => (touchOnly() ? files : folder).click());
  $('#welcomeOpen').addEventListener('click', () => folder.click());
  $('#welcomeFiles').addEventListener('click', () => files.click());
  $('#welcomeDemo').addEventListener('click', openDemo);
  $<HTMLAnchorElement>('#welcomeReal').href = DEMO_SCAN.url;
  for (const input of [folder, files]) {
    input.addEventListener('change', () => {
      const entries = input.files ? entriesFromInput(input.files) : [];
      input.value = '';
      openEntries(entries);
    });
  }

  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');
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
    if (e.dataTransfer) entriesFromDrop(e.dataTransfer).then(openEntries).catch(fail);
  });

  window.addEventListener('keydown', (e) => {
    if (target(e)?.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const hovered = S.hoverKind && views[S.hoverKind];
    if (k === 'Escape' && !$('#center').hidden) {
      closeCenter();
    } else if (k === 'Escape' && $('#topbar').classList.contains('open')) {
      setMenu(false);
    } else if (k === 'Escape') {
      S.drawing = null;
      S.measuring = null;
      S.angleDraft = null;
      const max = document.querySelector<HTMLElement>('.view.maximized');
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
    } else if (k === 'f' && hovered && hovered.el) {
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
      const tool = TOOL_KEYS[k];
      if (tool) setTool(tool);
    }
  });
}

// ---------------------------------------------------------------- help centre: guide, privacy, about, terms

const TABS = ['guide', 'privacy', 'about', 'terms'];
const privacy: { blocked: number; timer?: ReturnType<typeof setInterval> } = { blocked: 0 };

function setHash(tab: string) {
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
  center.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  center.querySelectorAll<HTMLElement>('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== tab; });
  find(center, '.center-body').scrollTop = 0;
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
  $('#welcomeRealLabel').textContent = t('welcome.real', { size: DEMO_SCAN.size });
  $('#aboutVersion').textContent = t('about.version', { v: document.documentElement.dataset.version || 'dev' });
  const site = document.createElement('a');
  site.href = CREATOR_SITE.url;
  site.target = '_blank';
  site.rel = 'noopener noreferrer';
  site.textContent = CREATOR_SITE.label;
  $('#aboutCreator').replaceChildren(`${t('about.creator', { name: CREATOR })} (`, site, ')');
}

// The live privacy panel reports what the browser itself says about this page.
// Some antivirus products intercept HTTPS and add their own hosts to the policy so they can
// inject a script; the check reads the effective policy and names any such hosts.
function cspStatus() {
  const policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content || '';
  if (!policy) return { on: false, hosts: [] };
  const directives: Record<string, string[]> = {};
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives[name.toLowerCase()] = sources;
  }
  const connect = directives['connect-src'] ?? directives['default-src'] ?? ['*'];
  const open = connect.some((s) => s === '*' || /^(https?|wss?):$/i.test(s));
  const hosts = [...new Set(Object.values(directives).flat()
    .filter((s) => /^(https?|wss?):\/\//i.test(s))
    .map((s) => s.replace(/^\w+:\/\//, '').split('/')[0]))];
  return { on: !open, hosts };
}

function requestsAfterLoad() {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const loaded = nav ? nav.loadEventEnd || nav.domContentLoadedEventEnd : 0;
  const late = performance.getEntriesByType('resource').filter((e) => /^https?:/.test(e.name) && e.startTime > loaded);
  return { count: late.length, hosts: [...new Set(late.map((e) => new URL(e.name).host))] };
}

async function storedItems() {
  let n = 0;
  try { n += localStorage.length; } catch { /* blocked */ }
  try { n += sessionStorage.length; } catch { /* blocked */ }
  try { if (document.cookie) n += document.cookie.split(';').filter((c) => c.trim()).length; } catch { /* blocked */ }
  try { if (typeof globalThis.indexedDB?.databases === 'function') n += (await indexedDB.databases()).length; } catch { /* blocked */ }
  try { if (globalThis.caches) n += (await caches.keys()).length; } catch { /* blocked */ }
  return n;
}

function setCheck(sel: string, ok: boolean, text: string) {
  const row = $(sel);
  row.classList.toggle('ok', ok);
  row.classList.toggle('warn', !ok);
  find(row, '.v').textContent = text;
}

async function renderPrivacy() {
  if ($('#center').hidden || $('[data-panel="privacy"]').hidden) return;
  const requests = requestsAfterLoad();
  setCheck('#chkNetwork', requests.count === 0, requests.count
    ? t('privacy.check.network.some', { n: requests.count, hosts: requests.hosts.join(', ') })
    : t('privacy.check.network.none'));
  const csp = cspStatus();
  const cspText = !csp.on ? t('privacy.check.csp.off')
    : csp.hosts.length ? t('privacy.check.csp.modified', { hosts: csp.hosts.join(', '), n: privacy.blocked })
      : t('privacy.check.csp.on', { n: privacy.blocked });
  setCheck('#chkCsp', csp.on && !csp.hosts.length, cspText);
  const stored = await storedItems();
  setCheck('#chkStorage', stored === 0, stored ? t('privacy.check.storage.some', { n: stored }) : t('privacy.check.storage.none'));
  const mb = S.vol ? Math.round(S.vol.data.byteLength / 1048576) : 0;
  const name = S.meta?.demo ? t('patient.demo') : S.meta?.patientName || '—';
  setCheck('#chkMemory', true, S.vol ? t('privacy.check.memory.some', { name, mb }) : t('privacy.check.memory.none'));
  $<HTMLButtonElement>('#closeScanBtn').disabled = !S.vol;
}

// Drop every reference to the scan so the browser can free it, and clear rendered pixels.
function closeScan() {
  Object.assign(S, {
    vol: null, meta: null, lut: null, series: [], arches: [], arch: null, archIdx: -1, canals: [],
    measures: [], measuring: null, drawing: null, angleDraft: null, start: null,
  });
  curveMemo = null;
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

function showLoading(text: string, frac?: number) {
  $('#loading').hidden = false;
  $('#loadingLabel').textContent = text;
  $('#loadingBar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
}

function hideLoading() {
  $('#loading').hidden = true;
}

function errorText(err: unknown) {
  if (err instanceof DicomError) return t(`err.${err.code}`, { detail: err.detail });
  return (err instanceof Error && err.message) || String(err);
}

function fail(err: unknown) {
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
  const sel = $<HTMLSelectElement>('#series');
  sel.innerHTML = '';
  for (const s of S.series) sel.append(new Option(s.label, s.id));
  sel.hidden = S.series.length < 2;
}

async function load(id: string) {
  const entry = S.series.find((s) => s.id === id);
  if (!entry) return;
  $<HTMLSelectElement>('#series').value = id;
  window.__viewerReady = false;
  try {
    showLoading(t('loading.read'), 0);
    const { meta, data } = await loadSeries(entry.local, (f) => showLoading(t('loading.read'), f));
    setVolume(meta, data);
  } catch (err) {
    fail(err);
  }
}

// Files picked or dropped by the user, or the files inside a picked ZIP; nothing leaves the browser.
async function openEntries(entries: Entry[]) {
  if (!entries.length) return;
  try {
    showLoading(t('loading.scan'), 0);
    const found = await scanEntries(await expandArchives(entries), (f) => showLoading(t('loading.scan'), f));
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

function setVolume(meta: ScanMeta, data: Uint16Array) {
  const [nx, ny, nz] = meta.dims;
  const [sx, sy, sz] = meta.spacing;
  S.meta = meta;
  const vol = S.vol = { data, nx, ny, nz, sx, sy, sz, slope: meta.slope, intercept: meta.intercept, max: Math.max(meta.max, 1) };
  const an = meta.analysis;

  S.canals = (an?.canals ?? []).map((c) => ({
    name: c.name,
    radiusMm: c.radius,
    radiusVox: c.radius / sx,
    css: cssColor(c.color),
    dense: R.spline(c.points, 16),
    proj: null,
  }));

  S.arches = (an?.arches ?? []).map((a) => ({ name: a.name, type: a.type, points: a.points, demo: !!meta.demo }));
  // No arch in the scan's own analysis: find one from the teeth so the panoramic works.
  let auto: ReturnType<typeof detectArch> = null;
  if (!S.arches.length) {
    auto = detectArch(vol);
    if (auto) S.arches.push({ auto: true, type: 'Auto', points: auto.points });
  }
  let idx = S.arches.findIndex((a) => a.type === 'MandibularArch');
  if (idx < 0) idx = S.arches.length ? 0 : -1;

  const scanner = an?.lut ?? meta.window;
  PRESETS.scanner = scanner ? { c: scanner.center, w: scanner.width } : { c: 1048, w: 4096 };
  // The 3D view shows intensities from soft tissue up.
  const lo = (-200 - vol.intercept) / vol.slope;
  S.vrRange = [Math.max(0, lo), Math.max(lo + 1, meta.percentiles[1] * 1.05)];

  S.start = {
    cursor: an?.ortho ? an.ortho.slice() : [nx / 2, ny / 2, nz / 2],
    archIdx: idx,
    // A found arch with no saved position: start on the front teeth, not the middle of the volume.
    frontZ: auto && !an?.ortho ? (auto.slab[0] + auto.slab[1]) / 2 : null,
  };
  restoreOpeningState();

  renderPatient();
  document.title = `${meta.demo ? t('patient.demo') : meta.patientName || 'CBCT'} – ${t('app.name')}`;
  if (meta.demo) setMessage('msg.demo');
  else if (auto) setMessage('msg.autoarch');
  else if (!an?.arches?.length) setMessage('msg.noanalysis');
  else setMessage(null); // a scan with its own analysis needs no remark

  $('#welcome').hidden = true;
  document.body.classList.add('has-scan');
  hideLoading();
  prepare3d();
}

// Everything as it was when the scan opened: views, slices, display settings, tools and
// measurements. Loading a scan and Reset both end here.
function restoreOpeningState() {
  const start = S.start;
  if (!S.vol || !start) return;
  Object.assign(S, { ...DEFAULTS, invert: false, showCanals: true, showGuides: true });
  S.measures = [];
  S.measuring = null;
  S.drawing = null;
  S.angleDraft = null;
  S.arches = S.arches.filter((a) => !a.custom);
  syncControls();
  setTool('navigate');
  const max = document.querySelector<HTMLElement>('.view.maximized');
  if (max) toggleMax(max);
  showSecond('cross');

  KINDS_2D.forEach((k) => { views[k].sliceKey = null; views[k].resetView(); });
  setCursor(start.cursor);
  selectArch(start.archIdx);
  if (start.frontZ !== null && S.arch) {
    const m = S.arch.M >> 1;
    setCursor([S.arch.x[m], S.arch.y[m], start.frontZ]);
    refresh();
  }
  $<HTMLSelectElement>('#preset').value = 'bone';
  applyPreset('bone');
  if (vr && !vr.failed) {
    vr.reset();
    $<HTMLSelectElement>('#vrPreset').value = 'bone';
    applyVrPreset('bone');
  }
}

// Bring the controls in line with state that was changed in code.
function syncControls() {
  $<HTMLInputElement>('#panoThick').value = String(S.panoThick);
  $('#panoThickOut').textContent = `${S.panoThick} mm`;
  $<HTMLSelectElement>('#panoMode').value = S.panoMode;
  $<HTMLSelectElement>('#csStep').value = String(S.csStep);
  $<HTMLSelectElement>('#csWidth').value = String(S.csWidth);
  $('#invert').classList.toggle('active', S.invert);
  $<HTMLInputElement>('#showCanals').checked = S.showCanals;
  $<HTMLInputElement>('#showGuides').checked = S.showGuides;
}

// Built with text nodes only: values from the scan never reach innerHTML.
function renderPatient() {
  const el = $('#patient');
  el.replaceChildren();
  const m = S.meta;
  if (!m) return;
  const [nx, ny, nz] = m.dims;
  const label = m.demo ? t('patient.demo') : m.patientName;
  if (label) {
    const name = document.createElement('strong');
    name.textContent = label;
    el.append(name);
  }
  const parts = [
    m.birthDate && t('patient.dob', { v: m.birthDate }),
    m.studyDate && t('patient.scan', { v: m.studyDate }),
    m.model,
    `${nx}×${ny}×${nz} @ ${+m.spacing[0].toFixed(3)} mm`,
  ].filter(Boolean);
  // Phones show only the name when there is one.
  const details = document.createElement('span');
  details.className = 'details';
  for (const part of parts) {
    if (el.childNodes.length || details.childNodes.length) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      details.append(sep);
    }
    details.append(document.createTextNode(part));
  }
  el.append(details);
}

function prepare3d() {
  const view = vr, vol = S.vol;
  if (!view || view.failed || !vol) { window.__viewerReady = true; return; }
  setTimeout(() => {
    view.setVolume(vol, S.vrRange[0], S.vrRange[1]);
    applyVrPreset($<HTMLSelectElement>('#vrPreset').value);
    window.__viewerReady = true;
  }, 30);
}

function start() {
  for (const kind of KINDS_2D) {
    const el = $(`.view[data-view="${kind}"]`);
    el.style.setProperty('--accent', COLORS[kind]);
    views[kind] = new Viewport(el, kind, hooks);
  }
  const vrEl = $('.view[data-view="vr"]');
  vrEl.style.setProperty('--accent', COLORS.vr);
  vr = new VolumeView(vrEl, { dblclick: (v) => toggleMax(v.el) });
  if (vr.failed) find(vrEl, '.canvas-wrap').insertAdjacentHTML('beforeend', '<div class="empty"></div>');
  document.querySelectorAll<HTMLElement>('#viewtabs [data-show]').forEach((b) => {
    b.style.setProperty('--accent', COLORS[b.dataset.show as ViewKind | 'vr']);
  });
  showSecond('cross');
  // A view's size is set by the layout, never by its header, so this cannot feed back on itself.
  const viewSizes = new ResizeObserver(fitControls);
  document.querySelectorAll('.view').forEach((el) => viewSizes.observe(el));
  if (touchOnly()) {
    const files = $('#welcomeFiles'), folder = $('#welcomeOpen');
    files.classList.replace('ghost', 'primary');
    folder.classList.replace('primary', 'ghost');
    files.after(folder);
    $('.mouse-help').before($('.touch-help'));
  }

  for (const key of LEGACY_STORAGE_KEYS) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
  document.addEventListener('securitypolicyviolation', () => { privacy.blocked++; renderPrivacy(); });
  const langSelect = $<HTMLSelectElement>('#lang');
  for (const l of LANGUAGES) langSelect.append(new Option(l.name, l.id));

  bindUi();
  applyLanguage(detectLanguage());
  setTool('navigate');

  if (new URLSearchParams(location.search).has('demo')) openDemo();
  else $('#welcome').hidden = false;
  routeHash();
}

start();
