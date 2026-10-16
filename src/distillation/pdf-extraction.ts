import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { realpathSync as realpath } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceDocument } from './schema.ts';

interface PdfTools { python?: string; ocr_lang_path?: string; ocr_languages?: string }
export async function pdfTools(root: string): Promise<PdfTools> {
  let config: PdfTools = {};
  try { config = JSON.parse((await readFile(resolve(root, '.runtime/pdf-tools.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {
    ...config, python: process.env.SPINA_PDF_PYTHON ?? config.python,
    ocr_lang_path: process.env.SPINA_OCR_LANG_PATH ?? config.ocr_lang_path ?? '.runtime/tessdata',
    ocr_languages: process.env.SPINA_OCR_LANGUAGES ?? config.ocr_languages ?? 'eng+chi_sim',
  };
}

async function within(root: string, path: string) {
  const rel = relative(realpath(root), realpath(path));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('PDF 提取输出必须位于项目内');
}

function runTool(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise<string>((done, fail) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = []; let length = 0; let diagnostic = '';
    let failure: Error | undefined;
    child.stdout.on('data', (bytes: Buffer) => {
      length += bytes.length;
      if (length > 64 * 1024 * 1024) { failure = new Error('PDF 提取结果超过 64 MiB，未截断原文'); child.kill(); }
      else chunks.push(bytes);
    });
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-2000); });
    // Wait for close before deleting temporary files used by the subprocess.
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      if (failure) fail(failure);
      else if (signal?.aborted) fail(signal.reason);
      else if (code === 0) done(Buffer.concat(chunks).toString('utf8'));
      else fail(new Error(`PDF 提取失败：${diagnostic || code}`));
    });
  });
}

/** Undefined retains the existing PDF.js path when Python has not been configured. */
export async function extractPdf(root: string, pdf: string, signal?: AbortSignal): Promise<SourceDocument['pages'] | undefined> {
  const tools = await pdfTools(root);
  if (!tools.python) return undefined;
  const base = resolve(root, '.runtime/pdf-extraction');
  await mkdir(base, { recursive: true });
  await within(root, base);
  const temp = await mkdtemp(resolve(base, 'read-'));
  try {
    const output = await runTool(tools.python, ['-X', 'utf8', fileURLToPath(new URL('../skills/pdf-extraction/scripts/extract.py', import.meta.url)), pdf, '--images', temp], signal);
    const pages = JSON.parse(output) as (SourceDocument['pages'][number] & { ocr_image?: string })[];
    const scanned = pages.filter(page => page.ocr_image);
    if (scanned.length) {
      const langPath = resolve(root, tools.ocr_lang_path!);
      const languages = tools.ocr_languages!.split('+');
      if (!languages.length || languages.some(lang => !/^[a-z_]+$/.test(lang))) throw new Error('OCR 语言配置无效');
      for (const language of languages) {
        try { await readFile(resolve(langPath, `${language}.traineddata`)); }
        catch { throw new Error(`PDF 没有可读文本层，需先 OCR：缺少 ${language} 识别模型，请运行 npm run setup:pdf`); }
      }
      for (const page of scanned) await within(temp, page.ocr_image!);
      const input = resolve(temp, 'ocr-input.json');
      await writeFile(input, JSON.stringify(scanned.map(page => ({ number: page.number, path: page.ocr_image }))));
      // A subprocess makes cancellation and worker initialization failures bounded.
      const ocr = JSON.parse(await runTool(process.execPath, [fileURLToPath(new URL('../skills/pdf-extraction/scripts/ocr.mjs', import.meta.url)), langPath, languages.join('+'), input], signal)) as { number: number; text: string }[];
      for (const page of scanned) {
        signal?.throwIfAborted();
        const image = page.ocr_image!;
        delete page.ocr_image;
        const text = ocr.find(result => result.number === page.number)!.text;
        if (text.length > page.text.length) {
          if (page.text) page.native_text = page.text;
          page.text = text; page.layout_text = text; page.extraction_method = 'tesseract';
        }
        const directory = resolve(root, 'data/distillation/pages', basename(pdf, '.pdf'));
        await mkdir(directory, { recursive: true });
        await within(root, directory);
        const saved = resolve(directory, `ocr-page-${page.number}.png`);
        await copyFile(image, saved);
        page.image_path = relative(root, saved).split(sep).join('/');
        page.warnings = [...(page.warnings ?? []), 'OCR 文字可能含识别错误；公式、上下标和表格须对照原始页图核验。'];
      }
    }
    return pages;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
