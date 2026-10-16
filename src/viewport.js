// A 2D view: draws a grayscale plane with zoom/pan and forwards interaction to hooks.
// Image coordinates (u, v) are in plane pixels; pixel centers sit at integer + 0.5.
// With el = null it renders off-screen at a fixed size (used for reports and exports).

export class Viewport {
  constructor(el, kind, hooks, offscreen = null) {
    this.el = el;
    this.kind = kind;
    this.hooks = hooks;
    this.ratio = offscreen?.pixelRatio ?? null;
    this.wrap = el ? el.querySelector('.canvas-wrap') : null;
    this.canvas = el ? this.wrap.querySelector('canvas') : document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d');
    this.plane = null;
    this.pixelsDirty = true;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.cssW = 1;
    this.cssH = 1;
    this.drag = null;
    this.hover = null;
    if (offscreen) {
      this.cssW = offscreen.width;
      this.cssH = offscreen.height;
      this.canvas.width = Math.round(this.cssW * this.ratio);
      this.canvas.height = Math.round(this.cssH * this.ratio);
      return;
    }
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.bind();
  }

  pixelRatio() {
    return this.ratio ?? (window.devicePixelRatio || 1);
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    const dpr = this.pixelRatio();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.hooks.invalidate(this);
  }

  setPlane(plane) {
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

  toScreen(u, v) {
    return [this.ox + u * this.kx, this.oy + v * this.ky];
  }

  toImage(X, Y) {
    return [(X - this.ox) / this.kx, (Y - this.oy) / this.ky];
  }

  inside(u, v) {
    return this.plane && u >= 0 && v >= 0 && u < this.plane.w && v < this.plane.h;
  }

  remap(lut) {
    const { w, h, data } = this.plane;
    if (this.off.width !== w || this.off.height !== h || !this.img) {
      this.off.width = w;
      this.off.height = h;
      this.img = this.offCtx.createImageData(w, h);
      this.img32 = new Uint32Array(this.img.data.buffer);
    }
    const out = this.img32;
    const n = w * h;
    const last = lut.length - 1;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      out[i] = lut[v > last ? last : v];
    }
    this.offCtx.putImageData(this.img, 0, 0);
    this.pixelsDirty = false;
  }

  draw(lut) {
    const ctx = this.ctx;
    const dpr = this.pixelRatio();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (!this.plane) {
      this.hooks.overlay(this, ctx);
      return;
    }
    if (this.pixelsDirty) this.remap(lut);
    this.layout();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.off, this.ox, this.oy, this.plane.w * this.kx, this.plane.h * this.ky);
    this.hooks.overlay(this, ctx);
  }

  eventPos(e) {
    const r = this.canvas.getBoundingClientRect();
    const X = e.clientX - r.left, Y = e.clientY - r.top;
    const [u, v] = this.plane ? this.toImage(X, Y) : [0, 0];
    return { X, Y, u, v };
  }

  zoomAt(factor, X, Y) {
    if (!this.plane) return;
    this.layout();
    const [u, v] = this.toImage(X, Y);
    this.zoom = Math.min(40, Math.max(0.25, this.zoom * factor));
    this.layout();
    const [X2, Y2] = this.toScreen(u, v);
    this.panX += X - X2;
    this.panY += Y - Y2;
    this.hooks.invalidate(this);
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      if (!this.plane) return;
      c.setPointerCapture(e.pointerId);
      const pos = this.eventPos(e);
      let mode;
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) mode = 'pan';
      else if (e.button === 2) mode = 'wl';
      else mode = this.hooks.tool(this);
      this.drag = { mode, lastX: pos.X, lastY: pos.Y };
      if (mode !== 'pan' && mode !== 'wl' && mode !== 'zoom') this.hooks.dragStart(this, mode, pos, e);
      e.preventDefault();
    });

    c.addEventListener('pointermove', (e) => {
      const pos = this.eventPos(e);
      this.hover = pos;
      if (this.drag) {
        const dx = pos.X - this.drag.lastX, dy = pos.Y - this.drag.lastY;
        this.drag.lastX = pos.X;
        this.drag.lastY = pos.Y;
        switch (this.drag.mode) {
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
          default:
            this.hooks.dragMove(this, this.drag.mode, pos, e);
        }
      }
      this.hooks.hover(this, pos);
    });

    const end = (e) => {
      if (!this.drag) return;
      const mode = this.drag.mode;
      this.drag = null;
      if (mode !== 'pan' && mode !== 'wl' && mode !== 'zoom') this.hooks.dragEnd(this, mode, this.eventPos(e), e);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.hooks.hover(this, null);
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

    c.addEventListener('dblclick', (e) => this.hooks.dblclick(this, e));
  }
}
