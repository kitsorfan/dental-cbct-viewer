// Finger tracking shared by the 2D and 3D views: two-finger pinches and double-taps.
// Browsers do not report dblclick for touch consistently, so double-taps are recognised here.

const TAP_MS = 300, TAP_MOVE = 10, DOUBLE_MS = 350, DOUBLE_DIST = 30;

export class Touches {
  constructor() {
    this.points = new Map();
    this.lastTap = null;
    this.multi = false; // a second finger joined the current gesture
  }

  get count() {
    return this.points.size;
  }

  down(e) {
    if (!this.points.size) this.multi = false;
    this.points.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp });
    if (this.points.size > 1) this.multi = true;
  }

  move(e) {
    const p = this.points.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }
  }

  // Forget a lifted finger. True when it completes a double-tap.
  up(e) {
    const p = this.points.get(e.pointerId);
    this.points.delete(e.pointerId);
    if (!p || this.multi || e.pointerType !== 'touch' || e.type !== 'pointerup') return false;
    const tap = e.timeStamp - p.t0 < TAP_MS && Math.hypot(p.x - p.x0, p.y - p.y0) < TAP_MOVE;
    const last = this.lastTap;
    this.lastTap = tap ? { x: p.x, y: p.y, t: e.timeStamp } : null;
    if (!tap || !last || e.timeStamp - last.t > DOUBLE_MS || Math.hypot(p.x - last.x, p.y - last.y) > DOUBLE_DIST) return false;
    this.lastTap = null;
    return true;
  }

  // Midpoint and spread of the first two fingers, in client pixels.
  pair() {
    const [a, b] = this.points.values();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
}
