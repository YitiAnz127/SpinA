import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { realpathSync as realpath } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SourceDocument } from './schema.ts';
import { sourceVersion, sourcePageDirectory } from './source-version.ts';

function within(root: string, path: string): void {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('页面图像必须位于项目内');
}

/** Render the source itself; never substitute a model-generated image or edited PDF. */
export async function renderSourcePages(root: string, source: SourceDocument, signal?: AbortSignal): Promise<void> {
  let executable = process.env.SPINA_PDFTOPPM_PATH;
  if (!executable) {
    try { executable = JSON.parse(await readFile(resolve(root, '.runtime/pdf-tools.json'), 'utf8')).pdftoppm; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  // Text-only installations retain their existing behavior and cannot claim image evidence.
  if (!executable) return;
  const pdf = resolve(root, source.path), version = await sourceVersion(root, pdf);
  const directory = sourcePageDirectory(root, version);
  await mkdir(directory, { recursive: true });
  within(await realpath(root), await realpath(directory));
  const indexPath = resolve(directory, 'render.json');
  let cached: { pages: { number: number; image_path: string }[] } | undefined;
  try { cached = JSON.parse(await readFile(indexPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!cached || cached.pages.length !== source.pages.length || !(await Promise.all(cached.pages.map(p => stat(resolve(root, p.image_path)).then(() => true, () => false)))).every(Boolean)) {
    signal?.throwIfAborted();
    await new Promise<void>((done, fail) => {
      const child = spawn(executable!, ['-scale-to', '1800', '-png', pdf, resolve(directory, 'page')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal });
      let diagnostic = '';
      child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-800); });
      child.once('error', fail);
      child.once('exit', code => code === 0 ? done() : fail(new Error(`PDF页面渲染失败（${code}）：${diagnostic}`)));
    });
    const files = await readdir(directory);
    const pages = source.pages.map(page => {
      const file = files.find(name => Number(/^page-(\d+)\.png$/.exec(name)?.[1]) === page.number);
      if (!file) throw new Error(`PDF页面渲染缺失：${source.path} 第${page.number}页`);
      return { number: page.number, image_path: relative(root, resolve(directory, file)).split(sep).join('/') };
    });
    cached = { pages };
    await writeFile(indexPath, JSON.stringify({ source_version: version, ...cached }, null, 2));
  }
  for (const page of source.pages) page.image_path = cached.pages.find(p => p.number === page.number)!.image_path;
}

export async function imageContent(root: string, images: { path: string; source_id: string; page: number }[]) {
  const content: ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string })[] = [];
  for (const image of images) {
    const path = await realpath(resolve(root, image.path));
    within(await realpath(root), path);
    const bytes = await readFile(path);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('页面图像不是PNG');
    content.push({ type: 'text', text: `原始PDF页面图像：${image.source_id} 第${image.page}页。文字层可能含OCR错误；仅按本页实际内容核对。` }, { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') });
  }
  return content;
}
