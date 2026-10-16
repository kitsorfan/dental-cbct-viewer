// Brand mark: a molar outline crossed by a dashed scan line. Drawn on a 24×24 grid.

export const ACCENT = '#2ec4b6';
export const TOOTH_PATH = 'M7.2 3.2c-2.4 0-4.2 1.9-4.2 4.4 0 2.4.9 4.2 1.8 6.2.8 1.8 1.1 3.8 1.5 5.8.3 1.5 1 2.4 2 2.4 1.2 0 1.7-1.1 2-2.6l.5-2.6c.2-1 .7-1.5 1.2-1.5s1 .5 1.2 1.5l.5 2.6c.3 1.5.8 2.6 2 2.6 1 0 1.7-.9 2-2.4.4-2 .7-4 1.5-5.8.9-2 1.8-3.8 1.8-6.2 0-2.5-1.8-4.4-4.2-4.4-1.7 0-2.6.9-4.8.9s-3.1-.9-4.8-.9z';

export function drawLogo(ctx, x, y, size, color = ACCENT) {
  const s = size / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.8;
  ctx.stroke(new Path2D(TOOTH_PATH));
  ctx.lineWidth = 1.5;
  ctx.setLineDash([2, 1.6]);
  ctx.beginPath();
  ctx.moveTo(0.8, 10.6);
  ctx.lineTo(23.2, 10.6);
  ctx.stroke();
  ctx.restore();
}
