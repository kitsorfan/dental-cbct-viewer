// A4 PDF report composed on canvases (drawn in millimetres) and written with pdf.js.
import { buildPdf } from './pdf.ts';
import type { PdfPage } from './pdf.ts';
import { drawLogo, ACCENT } from './brand.ts';

type Image = CanvasImageSource | null;

export interface Tile {
  title: string;
  subtitle?: string;
  render: (w: number, h: number) => Image;
}

// One serial cross-section: its sample on the arch, its number and its position text.
export interface CrossItem {
  index: number;
  label: number;
  detail: string;
}

export interface Column {
  label: string;
  width: number;
  align?: CanvasTextAlign;
}

// Everything the report needs, gathered by the app (see app.ts createPdfReport).
// Sizes passed to the render callbacks are in millimetres.
export interface ReportInput {
  appName: string;
  documentTitle: string;
  patient: string;
  created: string;
  banner: string;
  disclaimer: string;
  pageLabel: (n: number, total: number) => string;
  titles: { overview: string };
  info: [string, string][];
  pano: {
    title: string;
    subtitle: string;
    aspect: number;
    render: (w: number, h: number, extra?: { ticks?: CrossItem[]; compact?: boolean }) => Image;
  } | null;
  overviewTiles: Tile[];
  cross: {
    title: string;
    subtitle: string;
    range: (from: number, to: number, total: number) => string;
    aspect: number;
    items: CrossItem[];
    render: (item: CrossItem, w: number, h: number) => Image;
  } | null;
  views: {
    title: string;
    tiles: Tile[];
    measurementsTitle: string;
    none: string;
    columns: Column[];
    measurements: string[][];
  };
}

const DPI = 180;
const PX = DPI / 25.4;
// Images are rendered at CSS-pixel sizes (96 per inch) with this device ratio to reach DPI.
export const CSS_PER_MM = 96 / 25.4;
export const PIXEL_RATIO = DPI / 96;
const PAGE = [210, 297];
const M = 14;
const CONTENT_W = PAGE[0] - 2 * M;
const FOOTER_Y = PAGE[1] - M - 7;
const FONT = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const INK = '#16202a';
const MUTED = '#5b6876';
const RULE = '#d5dbe1';
const pt = (n: number) => n * 0.3528;

function font(size: number, weight = 400) {
  return `${weight} ${pt(size)}px ${FONT}`;
}

function newPage() {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(PAGE[0] * PX);
  canvas.height = Math.round(PAGE[1] * PX);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(PX, PX);
  ctx.textBaseline = 'alphabetic';
  return { canvas, ctx };
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  let s = String(text);
  if (ctx.measureText(s).width <= maxWidth) return s;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

function header(ctx: CanvasRenderingContext2D, r: ReportInput, title: string) {
  drawLogo(ctx, M, M - 1, 10);
  ctx.fillStyle = ACCENT;
  ctx.font = font(8.5, 600);
  ctx.fillText(r.appName, M + 13, M + 2.6);
  ctx.fillStyle = INK;
  ctx.font = font(15, 700);
  ctx.fillText(title, M + 13, M + 9);
  ctx.textAlign = 'right';
  ctx.font = font(11, 700);
  ctx.fillText(fitText(ctx, r.patient, 80), PAGE[0] - M, M + 3.2);
  ctx.font = font(8);
  ctx.fillStyle = MUTED;
  ctx.fillText(r.created, PAGE[0] - M, M + 8.6);
  ctx.textAlign = 'left';
  ctx.fillStyle = ACCENT;
  ctx.fillRect(M, M + 12, CONTENT_W, 0.6);
  let y = M + 18;
  if (r.banner) {
    ctx.fillStyle = '#e6f8f6';
    ctx.fillRect(M, y - 4, CONTENT_W, 7);
    ctx.fillStyle = '#0f6f66';
    ctx.font = font(8.5, 600);
    ctx.fillText(r.banner, M + 3, y + 0.8);
    y += 8;
  }
  return y;
}

function footer(ctx: CanvasRenderingContext2D, r: ReportInput, n: number, total: number) {
  ctx.fillStyle = RULE;
  ctx.fillRect(M, FOOTER_Y, CONTENT_W, 0.3);
  ctx.font = font(7);
  ctx.fillStyle = MUTED;
  const lines = wrap(ctx, r.disclaimer, CONTENT_W - 30);
  lines.slice(0, 2).forEach((line, i) => ctx.fillText(line, M, FOOTER_Y + 3.6 + i * 3));
  ctx.textAlign = 'right';
  ctx.fillText(r.pageLabel(n, total), PAGE[0] - M, FOOTER_Y + 3.6);
  ctx.textAlign = 'left';
}

function caption(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, sub?: string) {
  ctx.fillStyle = INK;
  ctx.font = font(9.5, 700);
  ctx.fillText(text, x, y);
  if (sub) {
    const w = ctx.measureText(text).width;
    ctx.font = font(8);
    ctx.fillStyle = MUTED;
    ctx.fillText(sub, x + w + 3, y);
  }
}

function imageBox(ctx: CanvasRenderingContext2D, source: Image, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, w, h);
  if (source) ctx.drawImage(source, x, y, w, h);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 0.25;
  ctx.strokeRect(x, y, w, h);
}

function infoGrid(ctx: CanvasRenderingContext2D, rows: [string, string][], y: number) {
  const colW = CONTENT_W / 2;
  const perCol = Math.ceil(rows.length / 2);
  rows.forEach(([key, value], i) => {
    const col = Math.floor(i / perCol);
    const x = M + col * colW;
    const yy = y + (i % perCol) * 5.6;
    ctx.font = font(8);
    ctx.fillStyle = MUTED;
    ctx.fillText(key, x, yy);
    ctx.font = font(9.5, 600);
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, value || '—', colW - 34), x + 30, yy);
  });
  return y + perCol * 5.6;
}

function table(ctx: CanvasRenderingContext2D, rows: string[][], cols: Column[], x: number, y: number, maxY: number) {
  const rowH = 5.4;
  const widths = cols.map((c) => c.width);
  const drawRow = (cells: string[], yy: number, head: boolean) => {
    ctx.font = head ? font(8, 700) : font(9);
    ctx.fillStyle = head ? MUTED : INK;
    let xx = x;
    cells.forEach((cell, i) => {
      ctx.textAlign = cols[i].align || 'left';
      const tx = cols[i].align === 'right' ? xx + widths[i] - 2 : xx + 2;
      ctx.fillText(fitText(ctx, cell, widths[i] - 4), tx, yy);
      xx += widths[i];
    });
    ctx.textAlign = 'left';
  };
  drawRow(cols.map((c) => c.label), y, true);
  ctx.fillStyle = RULE;
  ctx.fillRect(x, y + 1.6, widths.reduce((a, b) => a + b, 0), 0.3);
  let yy = y + rowH + 0.8;
  let i = 0;
  for (; i < rows.length && yy < maxY; i++, yy += rowH) {
    if (i % 2) {
      ctx.fillStyle = '#f3f6f8';
      ctx.fillRect(x, yy - 3.8, widths.reduce((a, b) => a + b, 0), rowH);
    }
    drawRow(rows[i], yy, false);
  }
  return i;
}

const toJpeg = (canvas: HTMLCanvasElement) => new Promise<PdfPage>((resolve, reject) => {
  canvas.toBlob(async (blob) => {
    if (!blob) { reject(new Error('Could not encode the report page')); return; }
    resolve({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height });
  }, 'image/jpeg', 0.9);
});

export async function createReport(r: ReportInput) {
  const pages: HTMLCanvasElement[] = [];
  const mm = (w: number, h: number): [number, number] => [w, h];

  // Page 1: overview.
  {
    const { canvas, ctx } = newPage();
    let y = header(ctx, r, r.titles.overview);
    y = infoGrid(ctx, r.info, y + 2) + 3;
    if (r.pano) {
      const h = Math.min(84, CONTENT_W / r.pano.aspect);
      const w = Math.min(CONTENT_W, h * r.pano.aspect);
      caption(ctx, r.pano.title, M, y + 3, r.pano.subtitle);
      imageBox(ctx, r.pano.render(...mm(w, h)), M + (CONTENT_W - w) / 2, y + 5, w, h);
      y += h + 12;
    }
    const tiles = r.overviewTiles;
    const gap = 6;
    const w = (CONTENT_W - gap) / 2;
    const rows = Math.ceil(tiles.length / 2);
    const h = Math.min(w, (FOOTER_Y - 6 - y - rows * 7) / rows);
    tiles.forEach((tile, i) => {
      const x = M + (i % 2) * (w + gap);
      const yy = y + Math.floor(i / 2) * (h + 9);
      caption(ctx, tile.title, x, yy + 3, tile.subtitle);
      imageBox(ctx, tile.render(w, h), x, yy + 5, w, h);
    });
    pages.push(canvas);
  }

  // Serial cross-sections at a fixed interval along the whole arch, as many pages as needed.
  // Each page starts with a small panoramic marking the sections it holds.
  if (r.cross && r.pano) { // serial sections are only made along a panoramic
    const cross = r.cross;
    const items = cross.items;
    const cols = 6, gap = 3, label = 4.6;
    const cw = (CONTENT_W - (cols - 1) * gap) / cols;
    const ch = cw / r.cross.aspect;
    const stripH = Math.min(30, CONTENT_W / r.pano.aspect);
    const stripW = stripH * r.pano.aspect;
    let start = 0;
    while (start < items.length) {
      const { canvas, ctx } = newPage();
      let y = header(ctx, r, r.cross.title);
      const top = y + 6 + stripH + 5;
      const rows = Math.max(1, Math.floor((FOOTER_Y - 3 - top + gap) / (ch + label + gap)));
      const pageItems = items.slice(start, start + rows * cols);
      ctx.font = font(8);
      ctx.fillStyle = MUTED;
      ctx.fillText(fitText(ctx, r.cross.subtitle, CONTENT_W - 45), M, y + 2.5);
      ctx.textAlign = 'right';
      ctx.font = font(8, 700);
      ctx.fillStyle = INK;
      ctx.fillText(r.cross.range(start + 1, start + pageItems.length, items.length), PAGE[0] - M, y + 2.5);
      ctx.textAlign = 'left';
      const strip = r.pano.render(stripW, stripH, { ticks: pageItems, compact: true });
      imageBox(ctx, strip, M + (CONTENT_W - stripW) / 2, y + 5, stripW, stripH);
      pageItems.forEach((item, i) => {
        const x = M + (i % cols) * (cw + gap);
        const yy = top + Math.floor(i / cols) * (ch + label + gap);
        ctx.font = font(7.5, 700);
        ctx.fillStyle = INK;
        ctx.fillText(String(item.label), x, yy + 2.6);
        const w = ctx.measureText(`${item.label} `).width;
        ctx.font = font(7);
        ctx.fillStyle = MUTED;
        ctx.fillText(item.detail, x + w + 1, yy + 2.6);
        imageBox(ctx, cross.render(item, cw, ch), x, yy + label - 0.8, cw, ch);
      });
      pages.push(canvas);
      start += pageItems.length;
    }
  }

  // Page 3+: current views and the measurement table.
  {
    let { canvas, ctx } = newPage();
    let y = header(ctx, r, r.views.title);
    const gap = 6;
    const w = (CONTENT_W - gap) / 2;
    const h = 66;
    r.views.tiles.forEach((tile, i) => {
      const x = M + (i % 2) * (w + gap);
      const yy = y + Math.floor(i / 2) * (h + 9);
      caption(ctx, tile.title, x, yy + 3, tile.subtitle);
      imageBox(ctx, tile.render(w, h), x, yy + 5, w, h);
    });
    y += Math.ceil(r.views.tiles.length / 2) * (h + 9) + 4;
    caption(ctx, r.views.measurementsTitle, M, y + 3);
    y += 9;
    if (!r.views.measurements.length) {
      ctx.font = font(9);
      ctx.fillStyle = MUTED;
      ctx.fillText(r.views.none, M, y);
      pages.push(canvas);
    } else {
      let rows = r.views.measurements;
      while (rows.length) {
        const drawn = table(ctx, rows, r.views.columns, M, y, FOOTER_Y - 4);
        pages.push(canvas);
        rows = rows.slice(drawn);
        if (rows.length) {
          ({ canvas, ctx } = newPage());
          y = header(ctx, r, r.views.title) + 4;
        }
      }
    }
  }

  pages.forEach((canvas, i) => {
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(PX, 0, 0, PX, 0, 0);
    footer(ctx, r, i + 1, pages.length);
  });

  const encoded: PdfPage[] = [];
  for (const canvas of pages) encoded.push(await toJpeg(canvas));
  return buildPdf(encoded, { title: r.documentTitle, author: r.appName, creator: r.appName });
}
