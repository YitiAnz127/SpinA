import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { realpathSync as realpath } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SourceDocument } from './schema.ts';
import { sourceVersion, sourcePageDirectory } from './source-version.ts';

const renderLocks = new Map<string, Promise<void>>();
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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
  if (!executable) {
    for (const page of source.pages) if (!page.image_path) {
      const message = '未配置 pdftoppm，本页没有提供原始页图；仅使用已提取的文字和表格。';
      page.warnings = [...new Set([...(page.warnings ?? []), message])];
    }
    return;
  }
  const pdf = resolve(root, source.path), version = await sourceVersion(root, pdf);
  const directory = sourcePageDirectory(root, version);
  await mkdir(directory, { recursive: true });
  within(await realpath(root), await realpath(directory));
  const previous = renderLocks.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(done => { release = done; });
  renderLocks.set(directory, current);
  await previous;
  try {
    signal?.throwIfAborted();
    const missing = [];
    for (const page of source.pages) {
      if (!Number.isSafeInteger(page.number) || page.number < 1) throw new Error('PDF 页码无效');
      const path = resolve(directory, `page-${page.number}.png`);
      const valid = await readFile(path).then(bytes => bytes.subarray(0, 8).equals(pngHeader), error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (!valid) missing.push(page.number);
    }
    const numbers = [...new Set(missing)].sort((a, b) => a - b);
    for (let i = 0; i < numbers.length;) {
      const first = numbers[i]; let last = first;
      while (++i < numbers.length && numbers[i] === last + 1) last = numbers[i];
      const temp = await mkdtemp(resolve(directory, 'render-'));
      try {
        const bounded = AbortSignal.any([AbortSignal.timeout(1200000), ...(signal ? [signal] : [])]);
        await new Promise<void>((done, fail) => {
          const child = spawn(executable!, ['-f', String(first), '-l', String(last), '-scale-to', '1800', '-png', pdf, resolve(temp, 'page')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal: bounded });
          let diagnostic = ''; let failure: Error | undefined;
          child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-800); });
          child.once('error', error => { failure = error; });
          child.once('close', code => failure ? fail(failure) : code === 0 ? done() : fail(new Error(`PDF页面渲染失败（${code}）：${diagnostic}`)));
        });
        const files = await readdir(temp);
        for (let number = first; number <= last; number++) {
          const file = files.find(name => Number(/^page-(\d+)\.png$/.exec(name)?.[1]) === number);
          if (!file) throw new Error(`PDF页面渲染缺失：${source.path} 第${number}页`);
          const path = resolve(temp, file);
          if (!(await readFile(path)).subarray(0, 8).equals(pngHeader)) throw new Error('页面图像不是PNG');
          // Concurrent processes may do duplicate work, but only complete PNGs become visible.
          await rename(path, resolve(directory, `page-${number}.png`));
        }
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
    for (const page of source.pages) page.image_path = relative(root, resolve(directory, `page-${page.number}.png`)).split(sep).join('/');
  } finally {
    release();
    if (renderLocks.get(directory) === current) renderLocks.delete(directory);
  }
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
