import { readFile, readdir, stat } from 'node:fs/promises';
import { realpathSync as realpath } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PaperIdentity, SourceDocument } from './schema.ts';
import { renderSourcePages } from './images.ts';
import { extractPdf } from './pdf-extraction.ts';

export interface SourceInput { path: string; kind?: 'body' | 'si' }
export interface DistillInput {
  paper_id: string;
  doi?: string;
  title?: string;
  sources?: SourceInput[];
}

export async function resolvePaper(root: string, input: DistillInput): Promise<{ paper: PaperIdentity; sources: SourceInput[] }> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.paper_id)) throw new Error('paper_id 只能包含字母、数字、下划线和连字符');
  const catalogPath = resolve(root, 'data/literature/selected-500.jsonl');
  let catalog: PaperIdentity[] = [];
  try {
    catalog = (await readFile(catalogPath, 'utf8')).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as PaperIdentity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const entry = catalog.find(paper => paper.paper_id === input.paper_id);
  const doi = input.doi?.trim().toLowerCase() ?? entry?.doi.toLowerCase();
  const title = input.title?.trim() ?? entry?.title;
  if (!doi || !/^10\.\d{4,9}\/\S+$/i.test(doi) || !title) throw new Error('新论文必须提供真实 DOI、题名及 sources；已收录论文可以只提供 paper_id');
  if (entry && (doi !== entry.doi.toLowerCase() || title !== entry.title)) throw new Error('题录与现有 paper_id 不一致，请使用正确 ID');
  const paper = { paper_id: input.paper_id, doi, title };
  if (input.sources?.length) return { paper, sources: input.sources };
  if (!entry) throw new Error('新论文需要明确指定正文和 SI 文件');

  // The index is a hint, not proof of document identity. Agents still check the sources.
  let index: Record<string, { file: string }> = {};
  try { index = JSON.parse(await readFile(resolve(root, 'data/paper/.doi_index.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const directory = resolve(root, 'data/paper');
  const encoded = doi.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const names = (await readdir(directory)).filter(name => name.toLowerCase() === `${encoded}.pdf` || name.toLowerCase().startsWith(`${encoded}_`));
  const candidates = [...new Set([index[doi]?.file, ...names.sort().map(name => resolve(directory, name))].filter((path): path is string => !!path))];
  if (!candidates.length) throw new Error('该论文尚无下载文件，请先加入正文和 SI');
  return { paper, sources: candidates.map(path => ({ path })) };
}

export async function readSources(root: string, inputs: SourceInput[], signal?: AbortSignal, options: { renderImages?: boolean; allowSI?: boolean } = {}): Promise<SourceDocument[]> {
  if (!inputs.length || inputs.length > 8) throw new Error('一次论文任务需要 1–8 个正文／SI 文件');
  const directory = await realpath(resolve(root, 'data/paper'));
  const projectRoot = realpath(root);
  const directoryRel = relative(projectRoot, directory);
  if (isAbsolute(directoryRel) || directoryRel === '..' || directoryRel.startsWith(`..${sep}`)) throw new Error('论文目录不能指向项目外部');
  const documents: SourceDocument[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    signal?.throwIfAborted();
    const path = await realpath(resolve(root, input.path));
    const rel = relative(directory, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('只能读取 data/paper 内的论文文件');
    if (seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    const info = await stat(path);
    if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('论文必须是小于 50 MiB 的 PDF 文件');
    const buffer = await readFile(path);
    signal?.throwIfAborted();
    if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error(`文件不是 PDF：${rel}`);
    let pages = await extractPdf(root, path, signal);
    if (!pages) {
      const task = getDocument({
        data: new Uint8Array(buffer), enableXfa: false, useSystemFonts: false,
        standardFontDataUrl: fileURLToPath(new URL('../../standard_fonts/', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'))).split(sep).join('/'),
        cMapUrl: fileURLToPath(new URL('../../cmaps/', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'))).split(sep).join('/'),
        cMapPacked: true,
      });
      const abort = () => { void task.destroy().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const pdf = await task.promise;
        pages = [];
        for (let number = 1; number <= pdf.numPages; number++) {
          signal?.throwIfAborted();
          const page = await pdf.getPage(number);
          const content = await page.getTextContent();
          const text = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
          pages.push({ number, text, extraction_method: 'pdfjs', warnings: ['未配置 Python 提取后端，仅使用 PDF.js 文字层；未进行结构化表格提取或 OCR。'] });
          page.cleanup();
        }
      } finally {
        signal?.removeEventListener('abort', abort);
        await task.destroy();
      }
    }
    if (!pages.some(page => page.text.length >= 30)) throw new Error(`PDF 没有可读文本层，需先 OCR：${rel}；请检查 PDF 提取配置或页面质量`);
    // Submitted manuscripts and SI may carry line numbers before their heading.
    const heading = pages[0].text.replace(/^\s*\d+\s*/gm, '').trim();
    const isSI = /^(?:supporting information|supplementary (?:information|material|data)|electronic supplementary)/i.test(heading);
    if (input.kind === 'body' && isSI) throw new Error(`文件以 SI 标题开头，不能指定为正文：${rel}`);
    documents.push({ id: `src_${documents.length + 1}`, path: relative(root, path).split(sep).join('/'), kind: input.kind ?? (isSI ? 'si' : 'body'), pages });
  }
  // Remove only text-identical downloads; differing body/SI versions remain available for verification.
  const unique: SourceDocument[] = [];
  for (const document of documents) {
    if (unique.some(existing => existing.kind === document.kind && existing.pages.map(page => page.text).join('\n') === document.pages.map(page => page.text).join('\n'))) continue;
    unique.push(document);
  }
  if (!options.allowSI && !unique.some(document => document.kind === 'body')) throw new Error('只有 SI，尚缺正文；不能开始整篇论文蒸馏');
  if (options.renderImages) for (const source of unique) await renderSourcePages(root, source, signal);
  return unique;
}
