import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import * as extraction from '../src/distillation/pdf-extraction.ts';

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'ocr-path-'));
  t.after(async () => {
    const rel = relative(base, root); assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('OCR language directories stay within the project', async t => {
  const root = await fixture(t);
  const valid = resolve(root, 'models'); await mkdir(valid);
  assert.equal(await extraction.ocrLanguageDirectory(root, 'models'), valid);
  await assert.rejects(extraction.ocrLanguageDirectory(root, process.cwd()), /OCR 语言模型目录必须位于项目内/);
});

test('OCR language directories reject outside targets through directory links', async t => {
  if (process.env.SPINA_TEST_DIRECTORY_LINKS === '0') return t.skip('当前执行环境未允许创建目录链接');
  const root = await fixture(t);
  const link = resolve(root, 'linked-models');
  try { await symlink(process.cwd(), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('当前执行环境未允许创建目录链接'); throw error; }
  try { await assert.rejects(extraction.ocrLanguageDirectory(root, link), /OCR 语言模型目录必须位于项目内/); }
  finally { await unlink(link); }
});
