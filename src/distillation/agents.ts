import { readFile } from 'node:fs/promises';
import type { TSchema } from 'typebox';
import { CompactDraftSchema, CompactVerificationSchema, FocusedRepairSchema, applyFocusedRepair, compactDraft, focusedRepairSchema, parseDraft, parseVerification } from './schema.ts';
import type { Draft, DraftReviewNote, Verification, PaperIdentity, SourceDocument } from './schema.ts';
import { deliveryRecord, sourceManifest } from './store.ts';

export interface AgentRequest {
  stage: 'distill' | 'verify' | 'repair';
  system: string;
  input: string;
  signal?: AbortSignal;
  images?: { path: string; source_id: string; page: number }[];
  outputShape?: 'draft' | 'patch';
}
export type ModelCall = (request: AgentRequest) => Promise<string>;

// 核验只需要核读草稿实际引用到的页：正文/SI 全文仍在文本层里，页图只用于核实被引用处的排版、上下标与 OCR 差异。
// 全量页图会让每篇核验的输入膨胀到 6 万 token 以上（页图约占七成），而绝大多数页与被核验的事实无关。
function citedPageKeys(draft: Draft): Set<string> {
  const keys = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const object = node as Record<string, unknown>;
    if ('raw' in object && 'status' in object && Array.isArray(object.evidence)) {
      for (const ref of object.evidence as { source_id?: string; page?: number }[]) {
        if (ref?.source_id && typeof ref.page === 'number') keys.add(`${ref.source_id}:${ref.page}`);
      }
    }
    Object.values(object).forEach(walk);
  };
  walk(draft);
  return keys;
}

/** 核验需要的页图：默认只给 basis='page_image' 的证据页；一旦存在 OCR 差异（quote 与页文本不符），所有引用页都要看图核读。 */
function imagePageKeys(draft: Draft, notes: DraftReviewNote[] = []): Set<string> {
  const keys = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const object = node as Record<string, unknown>;
    if (Array.isArray(object.evidence)) {
      for (const ref of object.evidence as { source_id?: string; page?: number; basis?: string }[]) {
        if (ref?.basis === 'page_image' && ref.source_id && typeof ref.page === 'number') keys.add(`${ref.source_id}:${ref.page}`);
      }
    }
    Object.values(object).forEach(walk);
  };
  walk(draft);
  if (notes.some(note => note.kind === 'quote_mismatch')) for (const key of citedPageKeys(draft)) keys.add(key);
  return keys;
}

const pageImages = (sources: SourceDocument[], allowed?: Set<string>) => {
  return sources.flatMap(source => source.pages.flatMap(page => {
    if (!page.image_path) return [];
    const key = `${source.id}:${page.number}`;
    if (allowed && !allowed.has(key)) return [];
    return [{ path: page.image_path, source_id: source.id, page: page.number }];
  }));
};

/** 修正需要的页：草稿已引用的页 + 核验问题取证所在的页（覆盖需要补遗漏的情形）。 */
function issuePageKeys(feedback: unknown): Set<string> {
  const keys = new Set<string>();
  const issues = (feedback as { verification?: { issues?: { source_evidence?: { source_id?: string; page?: number }[] }[] } | null })?.verification?.issues ?? [];
  for (const issue of issues) for (const ref of issue.source_evidence ?? []) {
    if (ref?.source_id && typeof ref.page === 'number') keys.add(`${ref.source_id}:${ref.page}`);
  }
  return keys;
}

/** 修正只需要看草稿引用到的页与核验取证所在的页；重发全文会白白多花几万 token。 */
function repairSources(sources: SourceDocument[], draft: Draft, feedback: unknown): SourceDocument[] {
  const keep = new Set([...citedPageKeys(draft), ...issuePageKeys(feedback)]);
  if (!keep.size) return sources;
  const trimmed = sources.map(source => ({ ...source, pages: (source.pages ?? []).filter(page => keep.has(`${source.id}:${page.number}`)) })).filter(source => source.pages.length);
  return trimmed.length ? trimmed : sources;
}

async function systemPrompt(name: 'distill' | 'verify' | 'repair', schema: TSchema, stage: string): Promise<string> {
  const fixed = await readFile(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8');
  // 修正是改 JSON 字段：不需要 PDF 读取规范，也不需要草稿级的 Fact/identity 写法规则，带上只会多花 token 并把它带回"写草稿"。
  const pdfSkill = name === 'repair' ? '' : (await readFile(new URL('../skills/pdf-extraction/SKILL.md', import.meta.url), 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const rules = name === 'repair'
    ? '严格按上述格式输出：顶层只有 patches（必要时 add_samples），不返回 notes/samples/assessment 等草稿级字段。\n'
    : 'Fact只写raw和evidence；value与raw不同时才写value，unit/status/note仅在必要时填写。默认value=raw、status=reported。\n' +
      'raw必须连续出现于同一条quote。quote取最短充分原文；不换算、不推测、不填derived。文字证据须在页文本中，page_image仅用于实际提供的对应页图像。\n' +
      '目标相identity.value用spinel/normal_spinel/inverse_spinel；不确定时标ambiguous。只有目标相全部金属有依据时才写metal_elements.value符号数组；前驱体、载体不能替代目标相依据。\n';
  return `${fixed}\n\n${pdfSkill}\n\n当前执行阶段：${stage}\n` +
    '只返回一个符合下述 JSON Schema 的 JSON 对象，不输出解释或 Markdown。\n' +
    '只输出有用字段，省略空数组、空字符串、null 和未报告的可选字段。\n' +
    rules + JSON.stringify(schema);
}

export class DistillationAgent {
  private call: ModelCall;
  constructor(call: ModelCall) { this.call = call; }

  async extract(paper: PaperIdentity, sources: SourceDocument[], signal?: AbortSignal): Promise<Draft> {
    return parseDraft(await this.call({
      stage: 'distill', system: await systemPrompt('distill', CompactDraftSchema, '仅抽取目标相与制备方法'),
      input: JSON.stringify({ paper, sources }), signal, images: pageImages(sources),
    }));
  }

  async repair(paper: PaperIdentity, sources: SourceDocument[], draft: Draft, feedback: unknown, signal?: AbortSignal): Promise<Draft> {
    const context = feedback as { repair_round?: number; repair_limit?: number; final_round?: boolean };
    const instruction = context.final_round
      ? '这是最后一次修正。优先保守收敛：删除无原文明示依据的推算，不确定的条件改为ambiguous/source_missing/not_reported并说明；保留真实样品及已确认的组成和制备信息。不能靠虚构数值或隐藏问题宣称通过。输出应比原草稿更忠实于来源，足以供带疑惑标记的检索使用。'
      : '仅按具体反馈修正，保留已确认正确的信息。核验建议也必须对照原文，不能直接当成新实验事实。无法确认的内容明确标为未知，不反复扩展无关内容。';
    return parseDraft(await this.call({
      stage: 'repair', system: await systemPrompt('distill', CompactDraftSchema, `第${context.repair_round ?? 1}/${context.repair_limit ?? 3}次修正`) + '\n' + instruction,
      input: JSON.stringify({ paper, sources: repairSources(sources, draft, feedback), draft: compactDraft(draft), feedback }), signal, images: pageImages(sources, new Set([...citedPageKeys(draft), ...issuePageKeys(feedback)])),
    }));
  }

  async repairFocused(paper: PaperIdentity, sources: SourceDocument[], draft: Draft, feedback: unknown, signal?: AbortSignal): Promise<Draft> {
    const context = feedback as { repair_round: number; repair_limit: number };
    return applyFocusedRepair(await this.call({
      stage: 'repair', outputShape: 'patch', system: await systemPrompt('repair', focusedRepairSchema(draft), `定点修正第${context.repair_round}/${context.repair_limit}次`) +
        '\n只返回patches：sample_local_id必须逐字复制input.sample_ids里的值（不能简写为s1或自造名称，写错会被程序拒收）；每项指定现有sample_local_id和changes中确需修正的字段，不能重写整篇或返回完整draft。修改数组字段时只给出需要改动的条目（steps/materials/phases按local_id、variables按name定位），未列出的条目由程序原样保留；其他样品和字段同样由程序保留。空steps默认不删除已有步骤，只有确须删除全部步骤时才显式clear_steps=true；拆分分支时必须保留父模板中已核验的共同前处理并由子分支继承。只有核验指出缺少真实制备分支时才使用add_samples，不能新增性能对照。source_limit不靠猜测消除；仅当其限定漏传时补说明。必须修正已确认遗漏、错配和继承错误，不能只增加一条“仍有疑惑”的备注来代替修正。金属集合已明确时可独立确认metal_elements，不要求精确相计量。',
      input: JSON.stringify({ paper, sample_ids: draft.samples.map(sample => sample.local_id), sources: repairSources(sources, draft, feedback), draft: compactDraft(draft), feedback }), signal, images: pageImages(sources, new Set([...citedPageKeys(draft), ...issuePageKeys(feedback)])),
    }), draft);
  }
}

export class VerificationAgent {
  private call: ModelCall;
  constructor(call: ModelCall) { this.call = call; }

  async verify(paper: PaperIdentity, sources: SourceDocument[], draft: Draft, signal?: AbortSignal, reviewNotes: DraftReviewNote[] = [], previousReview?: Verification): Promise<Verification> {
    return parseVerification(await this.call({
      stage: 'verify', system: await systemPrompt('verify', CompactVerificationSchema, previousReview
        ? '对照当前草稿重新判断样品状态，追踪旧问题并检查本次修正的关联影响'
        : '仅核验匹配与制备所需事实'),
      input: JSON.stringify({
        paper, sources, draft, reader_view: deliveryRecord({ paper, sources: sourceManifest(sources), draft, match_entries: [] }), review_notes: reviewNotes,
        ...(previousReview ? {
          previous_verification: previousReview,
          focus: '逐条检查 previous_verification.issues 在当前草稿中是否已解决：已解决就移除，未解决则保留。根据当前草稿重新判断 source_identity、coverage 和每个样品的 has_confirmed_errors、has_unresolved_issues、can_match，不能复制历史标志。检查本次修正及其共用流程、分支和匹配的关联影响；发现修正引入的实质错误或遗漏也要报告。所有判断在本次核验中完成，不额外建立第二份抽取结果。',
        } : {}),
      }), signal, images: pageImages(sources, imagePageKeys(draft, reviewNotes)),
    }));
  }
}
