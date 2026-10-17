// Bundle the app into one self-contained dist/index.html (works from file:// and GitHub Pages).
// The ES modules are wrapped in function scopes in dependency order; no tooling needed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const MODULES = ['i18n.js', 'brand.js', 'reslice.js', 'viewport.js', 'vr.js', 'dicom.js', 'phantom.js', 'autoarch.js', 'pdf.js', 'report.js', 'app.js'];
const EXPORT = /^export\s+(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

function bundleModule(file) {
  let code = fs.readFileSync(path.join(src, file), 'utf8');
  const exports = [...code.matchAll(EXPORT)].map((m) => m[1]);
  code = code.replace(/^export\s+/gm, '');
  code = code.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+'\.\/([\w-]+)\.js';/gm, (_, name, mod) => {
    if (!MODULES.includes(`${mod}.js`)) throw new Error(`${file}: unknown module ${mod}`);
    return `const ${name} = __${mod};`;
  });
  code = code.replace(/^import\s+\{([^}]+)\}\s+from\s+'\.\/([\w-]+)\.js';/gm, (_, names, mod) => {
    if (!MODULES.includes(`${mod}.js`)) throw new Error(`${file}: unknown module ${mod}`);
    return `const {${names}} = __${mod};`;
  });
  if (/^\s*(import|export)\s/m.test(code)) throw new Error(`${file}: unsupported import/export form`);
  return `const __${path.basename(file, '.js')} = (() => {\n${code}\nreturn { ${exports.join(', ')} };\n})();\n`;
}

export function build() {
  const missing = fs.readdirSync(src).filter((f) => f.endsWith('.js') && !MODULES.includes(f));
  if (missing.length) throw new Error(`Add to MODULES in build order: ${missing.join(', ')}`);

  // Line endings are normalised so the script hash matches what the browser parses.
  const lf = (s) => s.replace(/\r\n?/g, '\n');
  const css = lf(fs.readFileSync(path.join(src, 'style.css'), 'utf8'));
  const js = lf(MODULES.map(bundleModule).join('\n'));
  if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error('closing tag inside inlined source');
  const script = `\n(() => {\n'use strict';\n${js}})();\n`;
  const hash = crypto.createHash('sha256').update(script, 'utf8').digest('base64');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  let html = lf(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  const replace = (from, to) => {
    if (!html.includes(from)) throw new Error(`index.html is missing: ${from}`);
    html = html.replace(from, () => to);
  };
  replace('<link rel="stylesheet" href="src/style.css">', `<style>\n${css}</style>`);
  replace('<script type="module" src="src/app.js"></script>', `<script>${script}</script>`);
  replace('data-build="dev"', 'data-build="bundle"');
  replace('data-version="dev"', `data-version="${version}"`);
  // Only this exact inline script may run; styles stay inline-only.
  replace("script-src 'self'", `script-src 'sha256-${hash}'`);
  replace("style-src 'self' 'unsafe-inline'", "style-src 'unsafe-inline'");

  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, 'index.html');
  fs.writeFileSync(out, html);
  return { out, bytes: Buffer.byteLength(html) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, bytes } = build();
  console.log(`${path.relative(root, out)}  ${(bytes / 1024).toFixed(0)} KB`);
}
