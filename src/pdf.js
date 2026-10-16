// Minimal PDF writer: each page is one full-page JPEG. Text is drawn into the page image,
// so any script (Greek included) works without embedding fonts.

const A4 = [595.28, 841.89];

function bytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

// PDF text string as UTF-16BE hex, which accepts any Unicode text.
function textString(str) {
  let hex = 'FEFF';
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    const units = code > 0xffff
      ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)]
      : [code];
    for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
}

// pages: [{ jpeg: Uint8Array, width, height }] (pixel size of each JPEG)
export function buildPdf(pages, { title = '', author = '', creator = '', size = A4, date = new Date() } = {}) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const b = typeof data === 'string' ? bytes(data) : data;
    chunks.push(b);
    length += b.length;
  };
  const object = (n, write) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    write();
    push('\nendobj\n');
  };

  const [W, H] = size;
  const pageIds = pages.map((_, i) => 4 + i * 3);
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`));
  object(3, () => push(`<< /Title ${textString(title)} /Author ${textString(author)} /Creator ${textString(creator)} /Producer ${textString(creator)} /CreationDate ${pdfDate(date)} >>`));

  pages.forEach((page, i) => {
    const id = pageIds[i];
    const content = `q ${W.toFixed(2)} 0 0 ${H.toFixed(2)} 0 0 cm /Im0 Do Q`;
    object(id, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`));
    object(id + 1, () => {
      push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    });
    object(id + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`);
      push(page.jpeg);
      push('\nendstream');
    });
  });

  const count = 4 + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
