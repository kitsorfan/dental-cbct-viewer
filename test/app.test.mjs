import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { STRINGS } from '../src/i18n.js';
import { buildPdf } from '../src/pdf.js';
import { makePhantom } from '../src/phantom.js';
import { build } from '../scripts/build.mjs';

const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('English and Greek define the same strings and placeholders', () => {
  assert.deepEqual(Object.keys(STRINGS.el).sort(), Object.keys(STRINGS.en).sort());
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const key of Object.keys(STRINGS.en)) assert.equal(vars(STRINGS.el[key]), vars(STRINGS.en[key]), key);
});

test('every string key used in the code and markup exists', () => {
  const code = fs.readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js')).map(src).join('\n');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const used = new Set([
    ...[...code.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]),
    ...[...code.matchAll(/setMessage\('([\w.]+)'/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n(?:-title|-html)?="([\w.]+)"/g)].map((m) => m[1]),
  ]);
  for (const key of used) assert.ok(key in STRINGS.en, `missing string: ${key}`);
});

test('the PDF writer produces a valid cross-reference table', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const blob = buildPdf([{ jpeg, width: 10, height: 14 }, { jpeg, width: 10, height: 14 }], { title: 'Αναφορά' });
  const text = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text, /\/Count 2/);
  const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
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
  assert.equal(meta.analysis.arches.length, 1);
  assert.equal(meta.analysis.canals.length, 2);
  assert.ok(meta.demo);
});

test('the single-file build has no module syntax left and compiles', () => {
  const { out } = build();
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /data-build="bundle"/);
  assert.doesNotMatch(html, /src="src\//);
  const script = html.match(/<script>\n([\s\S]*)<\/script>/)[1];
  assert.doesNotMatch(script, /^\s*(import|export)\s/m);
  assert.doesNotThrow(() => new vm.Script(script));
});
