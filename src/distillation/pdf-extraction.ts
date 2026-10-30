import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { realpathSync as realpath } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceDocument } from './schema.ts';
import { sourceVersion, sourcePageDirectory } from './source-version.ts';
import { Type } from 'typebox';
import { Check } from 'typebox/value';

const pagesSchema = Type.Array(Type.Object({
  number: Type.Integer({ minimum: 1 }), text: Type.String(),
  layout_text: Type.Optional(Type.String()), native_text: Type.Optional(Type.String()),
  ocr_image: Type.Optional(Type.String()),
  extraction_method: Type.Optional(Type.Union(['pdfjs', 'pdfplumber', 'pypdf', 'tesseract'].map(value => Type.Literal(value)))),
  warnings: Type.Optional(Type.Array(Type.String())),
  tables: Type.Optional(Type.Array(Type.Object({ bbox: Type.Array(Type.Number()), rows: Type.Array(Type.Array(Type.Union([Type.String(), Type.Null()]))) }))),
}), { minItems: 1 });
export function parseExtractionPages(output: string): (SourceDocument['pages'][number] & { ocr_image?: string })[] {
  const pages = JSON.parse(output);
  if (!Check(pagesSchema, pages) || pages.some((page: { number: number }, index: number) => page.number !== index + 1)) throw new Error('PDF 提取结果结构或连续页码无效');
  return pages;
}

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

async function within(root: string, path: string, label = 'PDF 提取输出') {
  const rel = relative(realpath(root), realpath(path));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label}必须位于项目内`);
}

export async function ocrLanguageDirectory(root: string, configuredPath: string): Promise<string> {
  const path = resolve(root, configuredPath);
  try { await within(root, path, 'OCR 语言模型目录'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('OCR 语言模型目录不存在，请运行 npm run setup:pdf');
    throw error;
  }
  return path;
}

function runTool(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  signal = AbortSignal.any([AbortSignal.timeout(1200000), ...(signal ? [signal] : [])]);
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
  const version = await sourceVersion(root, pdf);
  const base = resolve(root, '.runtime/pdf-extraction');
  await mkdir(base, { recursive: true });
  await within(root, base);
  const temp = await mkdtemp(resolve(base, 'read-'));
  try {
    const output = await runTool(tools.python, ['-X', 'utf8', fileURLToPath(new URL('../skills/pdf-extraction/scripts/extract.py', import.meta.url)), pdf, '--images', temp], signal);
    const pages = parseExtractionPages(output);
    const scanned = pages.filter(page => page.ocr_image);
    if (scanned.length) {
      const langPath = await ocrLanguageDirectory(root, tools.ocr_lang_path!);
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
      if (!Check(Type.Array(Type.Object({ number: Type.Integer({ minimum: 1 }), text: Type.String() })), ocr) || new Set(ocr.map(page => page.number)).size !== ocr.length) throw new Error('OCR 返回结果结构或页码无效');
      for (const page of scanned) {
        signal?.throwIfAborted();
        const image = page.ocr_image!;
        delete page.ocr_image;
        const result = ocr.find(result => result.number === page.number);
        if (!result) throw new Error(`OCR 结果缺少第 ${page.number} 页，请检查识别模型与页面`);
        const text = result.text;
        if (text.length > page.text.length) {
          if (page.text) page.native_text = page.text;
          page.text = text; page.layout_text = text; page.extraction_method = 'tesseract';
        }
        const directory = sourcePageDirectory(root, version);
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
