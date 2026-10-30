import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PaperIdentity } from './schema.ts';

/** Keep a bad line isolated, but report it rather than hiding an incomplete catalog. */
export async function readCatalog(root: string, optional = false): Promise<PaperIdentity[]> {
  return readCatalogFile(resolve(root, 'data/literature/selected-500.jsonl'), optional);
}

export async function readCatalogFile(path: string, optional = false): Promise<PaperIdentity[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (optional) return [];
      throw new Error('未找到 data/literature/selected-500.jsonl：批处理需要论文清单，每行一个 {"paper_id","doi","title"} JSON；单篇论文请用 /distill');
    }
    throw error;
  }
  const papers: PaperIdentity[] = [];
  for (const [index, line] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let paper;
    try { paper = JSON.parse(line); }
    catch { console.warn(`${path} 第 ${index + 1} 行不是有效 JSON，已跳过`); continue; }
    if (!paper || typeof paper.paper_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(paper.paper_id)) {
      console.warn(`${path} 第 ${index + 1} 行缺少有效 paper_id，已跳过`); continue;
    }
    // Preserve identifiable entries so resolving an invalid target fails explicitly.
    papers.push(paper);
  }
  return papers;
}
