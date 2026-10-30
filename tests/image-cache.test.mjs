import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSourcePages } from '../src/distillation/images.ts';

const project = fileURLToPath(new URL('../', import.meta.url));
const base = resolve(project, '.runtime/tests');
const config = await readFile(resolve(project, '.runtime/pdf-tools.json'), 'utf8')
  .then(text => JSON.parse(text.replace(/^\uFEFF/, '')), () => ({}));
const renderer = process.env.SPINA_PDFTOPPM_PATH ?? config.pdftoppm;
const canRender = renderer && await access(renderer).then(() => true, () => false);
const timestamp = new Date('2026-10-01T00:00:00.000Z');

function pdf(text) {
  const texts = Array.isArray(text) ? text : [text];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${texts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [i, value] of texts.entries()) {
    const stream = `BT /F1 28 Tf 50 700 Td (${value}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function fixture(t) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'image-cache-'));
  t.after(async () => {
    const actual = resolve(root), rel = relative(base, actual);
    assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
    await rm(actual, { recursive: true, force: true });
  });
  await mkdir(resolve(root, '.runtime'), { recursive: true });
  await writeFile(resolve(root, '.runtime/pdf-tools.json'), JSON.stringify({ pdftoppm: renderer }));
  return root;
}

async function source(root, path, text) {
  const absolute = resolve(root, path);
  await mkdir(resolve(absolute, '..'), { recursive: true });
  await writeFile(absolute, pdf(text));
  await utimes(absolute, timestamp, timestamp);
  return { id: 'src_1', path, kind: 'body', pages: [{ number: 1, text }] };
}

test('same-name PDF sources retain distinct page images even when size and modification time match', { skip: !canRender }, async t => {
  const root = await fixture(t);
  const first = await source(root, 'data/paper/a/body.pdf', 'SOURCE AAA');
  const second = await source(root, 'data/paper/b/body.pdf', 'SOURCE BBB');
  const firstInfo = await stat(resolve(root, first.path)), secondInfo = await stat(resolve(root, second.path));
  assert.equal(firstInfo.size, secondInfo.size);
  assert.equal(firstInfo.mtimeMs, secondInfo.mtimeMs);

  await renderSourcePages(root, first);
  const firstPath = first.pages[0].image_path;
  const firstImage = await readFile(resolve(root, firstPath));
  await renderSourcePages(root, second);
  const secondPath = second.pages[0].image_path;

  // Independently render the second source under another name as the image oracle.
  const reference = await source(root, 'data/paper/reference.pdf', 'SOURCE BBB');
  await renderSourcePages(root, reference);
  const secondImage = await readFile(resolve(root, secondPath));
  const expectedSecond = await readFile(resolve(root, reference.pages[0].image_path));
  assert.notEqual(firstPath, secondPath);
  assert.notDeepEqual(firstImage, expectedSecond);
  assert.deepEqual(secondImage, expectedSecond);
  assert.deepEqual(await readFile(resolve(root, firstPath)), firstImage);
});

test('replacing a PDF with equal size and modification time creates a new page version without overwriting old evidence', { skip: !canRender }, async t => {
  const root = await fixture(t);
  const original = await source(root, 'data/paper/body.pdf', 'VERSION AAA');
  const originalInfo = await stat(resolve(root, original.path));
  await renderSourcePages(root, original);
  const originalPath = original.pages[0].image_path;
  const originalImage = await readFile(resolve(root, originalPath));

  const replaced = await source(root, original.path, 'VERSION BBB');
  const replacedInfo = await stat(resolve(root, replaced.path));
  assert.equal(replacedInfo.size, originalInfo.size);
  assert.equal(replacedInfo.mtimeMs, originalInfo.mtimeMs);
  await renderSourcePages(root, replaced);
  const replacedPath = replaced.pages[0].image_path;

  assert.notEqual(originalPath, replacedPath);
  assert.notDeepEqual(await readFile(resolve(root, replacedPath)), originalImage);
  assert.deepEqual(await readFile(resolve(root, originalPath)), originalImage);
});

test('partial reads render only requested pages, reuse cache and fill missing pages safely under concurrency', { skip: !canRender }, async t => {
  const root = await fixture(t);
  const document = await source(root, 'data/paper/multi.pdf', ['PAGE ONE', 'PAGE TWO', 'PAGE THREE']);
  document.pages = [{ number: 2, text: 'PAGE TWO' }];
  await renderSourcePages(root, document);
  const pagePath = resolve(root, document.pages[0].image_path);
  const directory = resolve(pagePath, '..');
  assert.deepEqual(await readdir(directory), ['page-2.png']);
  const before = await stat(pagePath);
  const next = { ...document, pages: [{ number: 1, text: 'PAGE ONE' }, { number: 2, text: 'PAGE TWO' }] };
  await Promise.all([renderSourcePages(root, next), renderSourcePages(root, document)]);
  assert.deepEqual((await readdir(directory)).sort(), ['page-1.png', 'page-2.png']);
  assert.equal((await stat(pagePath)).mtimeMs, before.mtimeMs);
  await writeFile(pagePath, 'broken PNG');
  await renderSourcePages(root, document);
  assert.ok((await readFile(pagePath)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
});
