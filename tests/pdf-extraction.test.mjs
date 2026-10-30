import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSources } from '../src/distillation/documents.ts';
import spina from '../src/spina.ts';

const project = fileURLToPath(new URL('../', import.meta.url));
const config = await readFile(resolve(project, '.runtime/pdf-tools.json'), 'utf8').then(text => JSON.parse(text.replace(/^\uFEFF/, '')), () => ({}));
const python = process.env.SPINA_PDF_PYTHON ?? config.python;
const exec = promisify(execFile);
const fixtureFonts = new Map();

async function fixture(t) {
  const base = resolve(project, '.runtime/tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'pdf-extraction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'data/paper'), { recursive: true });
  await mkdir(resolve(root, '.runtime'), { recursive: true });
  await mkdir(resolve(root, '.runtime/tessdata'), { recursive: true });
  for (const language of ['eng', 'chi_sim']) {
    await copyFile(resolve(project, config.ocr_lang_path ?? '.runtime/tessdata', `${language}.traineddata`), resolve(root, '.runtime/tessdata', `${language}.traineddata`))
      .catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await writeFile(resolve(root, '.runtime/pdf-tools.json'), JSON.stringify({ python, ocr_lang_path: '.runtime/tessdata', ocr_languages: 'eng' }));
  const { stdout } = await exec(python, [resolve(project, 'tests/fixtures/pdf-extraction.py'), resolve(root, 'data/paper')]);
  try { fixtureFonts.set(root, JSON.parse(stdout.trim().split('\n').pop() || '{}')); } catch { fixtureFonts.set(root, {}); }
  return root;
}

test('extracts table rows and OCRs an image-only page in a mixed PDF with original page numbers', { skip: !python }, async t => {
  const root = await fixture(t);
  const [source] = await readSources(root, [{ path: 'data/paper/mixed.pdf' }]);
  assert.equal(source.id, 'src_1');
  assert.deepEqual(source.pages.map(page => page.number), [1, 2]);
  assert.deepEqual(source.pages[0].tables[0].rows, [['Sample', 'Temperature'], ['A', '400 C'], ['B', '500 C']]);
  assert.match(source.pages[0].layout_text, /400 C/);
  assert.equal(source.pages[1].extraction_method, 'tesseract');
  assert.match(source.pages[1].text, /500 C/);
  assert.match(source.pages[1].text, /2 hours/);
  assert.ok(source.pages[1].image_path);
  assert.ok((await readFile(resolve(root, source.pages[1].image_path))).length > 100);
});

test('reads a fully scanned body and rejects a scanned SI passed as the body', { skip: !python }, async t => {
  const root = await fixture(t);
  const [source] = await readSources(root, [{ path: 'data/paper/scanned.pdf' }]);
  assert.match(source.pages[0].text, /Sample B/i);
  await assert.rejects(readSources(root, [{ path: 'data/paper/scanned-si.pdf', kind: 'body' }]), /不能指定为正文/);
});

test('native page-reading tool returns paginated text and structured tables without a model request', { skip: !python }, async t => {
  const root = await fixture(t);
  const tools = new Map();
  spina({ registerMarkdownTransformer: () => {}, registerTool: tool => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} });
  assert.ok(tools.has('read_paper_pages'));
  const ctx = { cwd: root, hasUI: false };
  const input = { paper_id: 'FIXTURE-PDF', doi: '10.1234/fixture', title: 'Synthetic extraction fixture', sources: [{ path: 'data/paper/mixed.pdf' }], source_id: 'src_1', first_page: 2, last_page: 2 };
  const result = await tools.get('read_paper_pages').execute('read', input, undefined, undefined, ctx);
  assert.equal(result.details.pages.length, 1);
  assert.equal(result.details.pages[0].number, 2);
  assert.match(result.details.pages[0].text, /500 C/);
  assert.ok(result.content.some(block => block.type === 'image'));
  await assert.rejects(tools.get('read_paper_pages').execute('bad', { ...input, first_page: 3, last_page: 3 }, undefined, undefined, ctx), /页码/);
  const si = await tools.get('read_paper_pages').execute('si', { path: 'data/paper/numbered-si.pdf' }, undefined, undefined, ctx);
  assert.equal(si.details.source.kind, 'si');
  assert.match(si.details.pages[0].text, /Supporting Information/);
  await assert.rejects(readSources(root, [{ path: 'data/paper/numbered-si.pdf', kind: 'body' }]), /不能指定为正文/);
  await assert.rejects(readFile(resolve(root, 'data/distillation/spina.sqlite')), { code: 'ENOENT' });
});

test('missing OCR language data fails clearly and releases temporary extraction files', { skip: !python }, async t => {
  const root = await fixture(t);
  await mkdir(resolve(root, '.runtime/missing-data'), { recursive: true });
  await writeFile(resolve(root, '.runtime/pdf-tools.json'), JSON.stringify({ python, ocr_lang_path: '.runtime/missing-data', ocr_languages: 'eng' }));
  await assert.rejects(readSources(root, [{ path: 'data/paper/scanned.pdf' }]), /缺少 eng 识别模型/);
  assert.deepEqual(await readdir(resolve(root, '.runtime/pdf-extraction')), []);
});

test('cancelling extraction stops its subprocess and releases temporary files', { skip: !python, timeout: 10000 }, async t => {
  const root = await fixture(t);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1000);
  try {
    await assert.rejects(readSources(root, [{ path: 'data/paper/scanned.pdf' }], abort.signal), error => error.name === 'AbortError');
  } finally { clearTimeout(timer); }
  assert.deepEqual(await readdir(resolve(root, '.runtime/pdf-extraction')), []);
});

test('local English and simplified Chinese language models recognize a bilingual scan', { skip: !python }, async t => {
  const root = await fixture(t);
  if (fixtureFonts.get(root)?.cjk === false) { t.skip('本机缺少中文字体，跳过中英混排 OCR 用例'); return; }
  await writeFile(resolve(root, '.runtime/pdf-tools.json'), JSON.stringify({ python, ocr_lang_path: '.runtime/tessdata', ocr_languages: 'eng+chi_sim' }));
  const [source] = await readSources(root, [{ path: 'data/paper/scanned-cn.pdf' }]);
  assert.match(source.pages[0].text.replace(/\s+/g, ''), /样品加热两小时/);
  assert.match(source.pages[0].text, /500 C/);
});

test('OCR evidence from same-name PDFs stays isolated across source directories', { skip: !python }, async t => {
  const root = await fixture(t);
  for (const name of ['a', 'b']) await mkdir(resolve(root, 'data/paper', name));
  await copyFile(resolve(root, 'data/paper/scanned.pdf'), resolve(root, 'data/paper/a/body.pdf'));
  await copyFile(resolve(root, 'data/paper/scanned-si.pdf'), resolve(root, 'data/paper/b/body.pdf'));
  const [a] = await readSources(root, [{ path: 'data/paper/a/body.pdf' }]);
  const path = a.pages[0].image_path, original = await readFile(resolve(root, path));
  const [b] = await readSources(root, [{ path: 'data/paper/b/body.pdf' }], undefined, { allowSI: true });
  assert.notEqual(path, b.pages[0].image_path);
  assert.notDeepEqual(original, await readFile(resolve(root, b.pages[0].image_path)));
  assert.deepEqual(await readFile(resolve(root, path)), original);
});
