// A 2D view: draws a grayscale plane with zoom/pan and forwards interaction to hooks.
// Image coordinates (u, v) are in plane pixels; pixel centers sit at integer + 0.5.
// With el = null it renders off-screen at a fixed size (used for reports and exports).
// Touch: one finger runs the tool, two fingers pinch to zoom and drag to pan.

import { Touches } from './touch.ts';
import type { Plane } from './reslice.ts';
import type { CrossItem } from './report.ts';

const MIN_ZOOM = 0.25, MAX_ZOOM = 40;
const SCROLL_PX = 10; // drag distance per slice with the scroll tool
// Modes the view handles itself; every other mode is a tool handled by the hooks.
const VIEW_MODES = new Set(['pan', 'zoom', 'wl', 'scroll']);

export type ViewKind = 'pano' | 'axial' | 'cross' | 'coronal' | 'sagittal';

// Calls fn whenever the screen's pixel ratio changes, e.g. when the window moves to a monitor
// with other scaling: no element changes size then, so no ResizeObserver fires.
export function onPixelRatioChange(fn: () => void) {
  const watch = () => {
    matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener('change', () => { fn(); watch(); }, { once: true });
  };
  watch();
}

// A pointer position on screen (X, Y in CSS pixels) and in the image (u, v).
export interface Pos {
  X: number;
  Y: number;
  u: number;
  v: number;
}

// Options for off-screen renders: numbered ticks on the panoramic, smaller labels, and strip:
// fill the width and crop to the height around the arch.
export interface RenderExtras {
  ticks?: CrossItem[];
  compact?: boolean;
  strip?: boolean;
  measureKey?: string | null;
  slice?: number[];
}

export interface ViewHooks {
  invalidate(vp: Viewport): void;
  overlay(vp: Viewport, ctx: CanvasRenderingContext2D): void;
  tool(vp: Viewport): string;
  windowLevel(dx: number, dy: number): void;
  // Returns how to undo the action, for when a second finger turns the gesture into a pinch.
  dragStart(vp: Viewport, mode: string, pos: Pos, e: PointerEvent): (() => void) | null;
  dragMove(vp: Viewport, mode: string, pos: Pos, e: PointerEvent): void;
  dragEnd(vp: Viewport, mode: string, pos: Pos, e: PointerEvent): void;
  hover(vp: Viewport, pos: Pos | null, lifted?: boolean): void;
  scroll(vp: Viewport, dir: number, e?: { shiftKey: boolean }): void;
  dblclick(vp: Viewport, e: Event): void;
}

interface Drag {
  mode: string;
  lastX: number;
  lastY: number;
  scrolled: number;
  cancel?: (() => void) | null;
}

export class Viewport {
  el: HTMLElement | null;
  kind: ViewKind;
  hooks: ViewHooks;
  ratio: number | null;
  // The pixel ratio the canvas was sized for; drawing uses it until the next resize.
  dpr = 1;
  wrap: HTMLElement | null;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  off = document.createElement('canvas');
  offCtx = this.off.getContext('2d')!;
  img: ImageData | null = null;
  img32: Uint32Array | null = null;
  plane: Plane | null = null;
  pixelsDirty = true;
  zoom = 1;
  panX = 0;
  panY = 0;
  cssW = 1;
  cssH = 1;
  // Set by layout() before anything is drawn or hit-tested.
  cssPerMm!: number;
  kx!: number;
  ky!: number;
  ox!: number;
  oy!: number;
  drag: Drag | null = null;
  pinch: { dist: number; zoom: number; anchor: [number, number] } | null = null;
  hover: Pos | null = null;
  // Kept by the app: the slice shown, the measurements that belong to it, render options.
  sliceKey: string | null = null;
  measureKey: string | null = null;
  report: RenderExtras | null = null;
  slice?: number[];

  constructor(el: HTMLElement | null, kind: ViewKind, hooks: ViewHooks,
    offscreen: { width: number; height: number; pixelRatio: number } | null = null) {
    this.el = el;
    this.kind = kind;
    this.hooks = hooks;
    this.ratio = offscreen?.pixelRatio ?? null;
    if (!el) {
      this.wrap = null;
      this.canvas = document.createElement('canvas');
    } else {
      const wrap = el.querySelector<HTMLElement>('.canvas-wrap');
      const canvas = wrap?.querySelector('canvas');
      if (!wrap || !canvas) throw new Error(`The ${kind} view has no canvas`);
      this.wrap = wrap;
      this.canvas = canvas;
    }
    this.ctx = this.canvas.getContext('2d')!;
    if (offscreen) {
      this.cssW = offscreen.width;
      this.cssH = offscreen.height;
      this.dpr = offscreen.pixelRatio;
      this.canvas.width = Math.round(this.cssW * offscreen.pixelRatio);
      this.canvas.height = Math.round(this.cssH * offscreen.pixelRatio);
      return;
    }
    if (this.wrap) new ResizeObserver(() => this.resize()).observe(this.wrap);
    onPixelRatioChange(() => this.resize());
    this.bind();
  }

  pixelRatio() {
    return this.ratio ?? (window.devicePixelRatio || 1);
  }

  resize() {
    if (!this.wrap) return;
    const r = this.wrap.getBoundingClientRect();
    this.dpr = this.pixelRatio();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.hooks.invalidate(this);
  }

  setPlane(plane: Plane | null) {
    this.plane = plane;
    this.pixelsDirty = true;
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  layout() {
    const p = this.plane;
    if (!p) return;
    const fit = Math.min(this.cssW / (p.w * p.sx), this.cssH / (p.h * p.sy)) * 0.96;
    this.cssPerMm = fit * this.zoom;
    this.kx = this.cssPerMm * p.sx;
    this.ky = this.cssPerMm * p.sy;
    this.ox = this.cssW / 2 - (p.w * this.kx) / 2 + this.panX;
    this.oy = this.cssH / 2 - (p.h * this.ky) / 2 + this.panY;
  }

  toScreen(u: number, v: number): [number, number] {
    return [this.ox + u * this.kx, this.oy + v * this.ky];
  }

  toImage(X: number, Y: number): [number, number] {
    return [(X - this.ox) / this.kx, (Y - this.oy) / this.ky];
  }

  inside(u: number, v: number) {
    return !!this.plane && u >= 0 && v >= 0 && u < this.plane.w && v < this.plane.h;
  }

  remap(plane: Plane, lut: Uint32Array) {
    const { w, h, data } = plane;
    let img = this.img, out = this.img32;
    if (this.off.width !== w || this.off.height !== h || !img || !out) {
      this.off.width = w;
      this.off.height = h;
      img = this.img = this.offCtx.createImageData(w, h);
      out = this.img32 = new Uint32Array(img.data.buffer);
    }
    const n = w * h;
    const last = lut.length - 1;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      out[i] = lut[v > last ? last : v];
    }
    this.offCtx.putImageData(img, 0, 0);
    this.pixelsDirty = false;
  }

  draw(lut: Uint32Array | null) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const plane = this.plane;
    if (!plane) {
      this.hooks.overlay(this, ctx);
      return;
    }
    if (this.pixelsDirty && lut) this.remap(plane, lut);
    this.layout();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.off, this.ox, this.oy, plane.w * this.kx, plane.h * this.ky);
    this.hooks.overlay(this, ctx);
  }

  eventPos(e: { clientX: number; clientY: number }): Pos {
    const r = this.canvas.getBoundingClientRect();
    const X = e.clientX - r.left, Y = e.clientY - r.top;
    const [u, v] = this.plane ? this.toImage(X, Y) : [0, 0];
    return { X, Y, u, v };
  }

  zoomAt(factor: number, X: number, Y: number) {
    if (!this.plane) return;
    this.layout();
    this.zoomTo(this.zoom * factor, this.toImage(X, Y), X, Y);
  }

  // Zoom so that image point (u, v) lands on screen point (X, Y).
  zoomTo(zoom: number, [u, v]: [number, number], X: number, Y: number) {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this.layout();
    const [X2, Y2] = this.toScreen(u, v);
    this.panX += X - X2;
    this.panY += Y - Y2;
    this.hooks.invalidate(this);
  }

  // The image point under the fingers stays under them while they pinch and move.
  startPinch(pair: { x: number; y: number; dist: number }) {
    this.layout();
    const r = this.canvas.getBoundingClientRect();
    this.pinch = { dist: pair.dist, zoom: this.zoom, anchor: this.toImage(pair.x - r.left, pair.y - r.top) };
  }

  movePinch(pinch: { dist: number; zoom: number; anchor: [number, number] }, pair: { x: number; y: number; dist: number }) {
    const r = this.canvas.getBoundingClientRect();
    this.zoomTo(pinch.zoom * (pair.dist / pinch.dist), pinch.anchor, pair.x - r.left, pair.y - r.top);
  }

  // Abandon a tool gesture, e.g. when a second finger turns it into a pinch.
  cancelDrag() {
    const d = this.drag;
    this.drag = null;
    d?.cancel?.();
  }

  bind() {
    const c = this.canvas;
    const touches = new Touches();
    let pointerType = 'mouse';
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      if (!this.plane) return;
      c.setPointerCapture(e.pointerId);
      e.preventDefault();
      pointerType = e.pointerType;
      touches.down(e);
      if (e.pointerType === 'touch' && touches.count === 2) {
        this.cancelDrag();
        this.startPinch(touches.pair());
        return;
      }
      if (touches.count > 1 || this.pinch) return;
      const pos = this.eventPos(e);
      let mode;
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) mode = 'pan';
      else if (e.button === 2) mode = 'wl';
      else mode = this.hooks.tool(this);
      this.drag = { mode, lastX: pos.X, lastY: pos.Y, scrolled: 0 };
      if (!VIEW_MODES.has(mode)) this.drag.cancel = this.hooks.dragStart(this, mode, pos, e);
      this.hooks.hover(this, pos); // a finger that taps without moving still gets a reading
    });

    c.addEventListener('pointermove', (e) => {
      const pos = this.eventPos(e);
      this.hover = pos;
      touches.move(e);
      if (this.pinch) {
        if (touches.count >= 2) this.movePinch(this.pinch, touches.pair());
        return;
      }
      const drag = this.drag;
      if (drag) {
        const dx = pos.X - drag.lastX, dy = pos.Y - drag.lastY;
        drag.lastX = pos.X;
        drag.lastY = pos.Y;
        switch (drag.mode) {
          case 'pan':
            this.panX += dx;
            this.panY += dy;
            this.hooks.invalidate(this);
            break;
          case 'zoom':
            this.zoomAt(Math.exp(-dy * 0.01), this.cssW / 2, this.cssH / 2);
            break;
          case 'wl':
            this.hooks.windowLevel(dx, dy);
            break;
          case 'scroll':
            // Like the wheel: dragging down moves as scrolling down does.
            drag.scrolled += dy;
            while (Math.abs(drag.scrolled) >= SCROLL_PX) {
              const dir = Math.sign(drag.scrolled);
              drag.scrolled -= dir * SCROLL_PX;
              this.hooks.scroll(this, dir);
            }
            break;
          default:
            this.hooks.dragMove(this, drag.mode, pos, e);
        }
      }
      this.hooks.hover(this, pos);
    });

    const release = (e: PointerEvent) => {
      const double = touches.up(e);
      if (this.pinch) {
        // The pinch lasts until every finger is lifted, so the last one does not start a tool.
        if (touches.count >= 2) this.startPinch(touches.pair());
        else if (!touches.count) this.pinch = null;
        return;
      }
      if (e.type === 'pointercancel') {
        this.cancelDrag();
      } else if (this.drag) {
        const mode = this.drag.mode;
        this.drag = null;
        if (!VIEW_MODES.has(mode)) this.hooks.dragEnd(this, mode, this.eventPos(e), e);
      }
      if (double) this.hooks.dblclick(this, e);
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('pointerleave', (e) => {
      this.hover = null;
      this.hooks.hover(this, null, e.pointerType === 'touch');
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.plane) return;
      const pos = this.eventPos(e);
      if (e.ctrlKey || e.metaKey) {
        this.zoomAt(Math.exp(-Math.sign(e.deltaY) * 0.12), pos.X, pos.Y);
      } else {
        this.hooks.scroll(this, Math.sign(e.deltaY), e);
      }
    }, { passive: false });

    // Touch double-taps are recognised in release(); some browsers also send dblclick for them.
    c.addEventListener('dblclick', (e) => { if (pointerType !== 'touch') this.hooks.dblclick(this, e); });
  }
}
