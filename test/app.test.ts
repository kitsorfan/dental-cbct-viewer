import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { STRINGS, LANGUAGES } from '../src/i18n.ts';
import { buildPdf } from '../src/pdf.ts';
import { makePhantom } from '../src/phantom.ts';
import { build } from '../scripts/build.ts';

const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

// Every source module as one text, for checks that scan the code.
function sources() {
  const files = fs.readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 10, `found the source modules (${files.length})`);
  return files.map(src).join('\n');
}

test('every language defines the same strings, placeholders and list items', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id).sort(), Object.keys(STRINGS).sort());
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  const items = (s: string) => (s.match(/<li>/g) || []).length;
  const keys = Object.keys(STRINGS.en).sort();
  for (const lang of Object.keys(STRINGS)) {
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), keys, `${lang} keys`);
    for (const key of keys) {
      assert.equal(vars(STRINGS[lang][key]), vars(STRINGS.en[key]), `${lang} ${key} placeholders`);
      assert.equal(items(STRINGS[lang][key]), items(STRINGS.en[key]), `${lang} ${key} list items`);
    }
  }
});

test('every string key used in the code and markup exists', () => {
  const code = sources();
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const used = new Set([
    ...[...code.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]),
    ...[...code.matchAll(/setMessage\('([\w.]+)'/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n(?:-title|-html|-aria)?="([\w.]+)"/g)].map((m) => m[1]),
  ]);
  for (const key of used) assert.ok(key in STRINGS.en, `missing string: ${key}`);
});

test('nothing is written to browser storage', () => {
  const code = sources();
  assert.doesNotMatch(code, /localStorage\.setItem|sessionStorage\.setItem|document\.cookie\s*=|indexedDB\.open|caches\.open/);
});

test('the PDF writer produces a valid cross-reference table', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const blob = buildPdf([{ jpeg, width: 10, height: 14 }, { jpeg, width: 10, height: 14 }], { title: 'Αναφορά' });
  const text = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text, /\/Count 2/);
  const startxref = Number(text.match(/startxref\n(\d+)/)?.[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((offset, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, offset), `object ${i + 1}`));
  assert.match(text, /\/Title <FEFF0391/);
});

test('the demo phantom has teeth, a metal crown and an analysis', () => {
  const { meta, data } = makePhantom({ voxelsPerMm: 1 });
  assert.deepEqual(meta.dims, [80, 80, 50]);
  assert.equal(data.length, 80 * 80 * 50);
  assert.ok(meta.max > 9000, 'metal crown');
  assert.ok(meta.analysis);
  assert.equal(meta.analysis.arches.length, 1);
  assert.equal(meta.analysis.canals.length, 2);
  assert.ok(meta.demo);
});

test('the single-file build compiles and only its own script may run', () => {
  const { out } = build();
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /data-build="bundle"/);
  assert.doesNotMatch(html, /src="src\//);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, 'inline script');
  assert.doesNotMatch(script, /^\s*(import|export)\s/m);
  assert.doesNotThrow(() => new vm.Script(script));

  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
  const hash = crypto.createHash('sha256').update(script, 'utf8').digest('base64');
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`), 'script hash matches the policy');
  for (const rule of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(rule), rule);
  assert.doesNotMatch(csp, /'self'|https?:/);
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(html.includes(`data-version="${version}"`), 'version stamped');

  const image = html.match(/property="og:image" content="([^"]+)"/)?.[1] ?? '';
  assert.ok(fs.existsSync(new URL(`../dist/${image.split('/').pop()}`, import.meta.url)), 'link preview image is published next to the page');
});
