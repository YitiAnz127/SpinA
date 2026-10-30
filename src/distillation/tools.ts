import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ModelCall } from './agents.ts';
import { runDistillation, matchingEntries } from './pipeline.ts';
import { ExperimentStore, deliveryRecord, type RecordReference } from './store.ts';
import { resolvePaper, readSources } from './documents.ts';
import { imageContent, renderSourcePages } from './images.ts';
import { createDeepSeekCall, deepSeekConfig, routeDistillationCalls } from './deepseek.ts';
import { SOL_POLICY, SOL_LABEL } from '../model-policy.ts';
import { applyFocusedRepair, parseModelJson } from './schema.ts';
import { classifyError } from '../errors.ts';
import { readSamplePreparation } from './preparation.ts';
import { readPreparationEvidence } from './evidence.ts';
import { searchPreparationConditions, PreparationConditionQuerySchema } from './conditions.ts';

const id = Type.String({ pattern: '^[A-Za-z0-9_-]{1,80}$' });
const SourceInputSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  kind: Type.Optional(Type.Union([Type.Literal('body'), Type.Literal('si')])),
}, { additionalProperties: false });
export const DistillInputSchema = Type.Object({
  paper_id: id,
  doi: Type.Optional(Type.String({ pattern: '^10\\.\\d{4,9}/\\S+$' })),
  title: Type.Optional(Type.String({ minLength: 1 })),
  sources: Type.Optional(Type.Array(SourceInputSchema, { minItems: 1, maxItems: 8 })),
}, { additionalProperties: false });

function verificationCall(ctx: ExtensionContext): ModelCall {
  const model = ctx.modelRegistry.find(SOL_POLICY.provider, SOL_POLICY.model);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error('核验需要已配置认证的 openai-codex/gpt-6.1-sol');
  return async request => {
    request.signal?.throwIfAborted();
    const outputBudget = Math.min(SOL_POLICY.outputTokens, model.maxTokens);
    // Conservative estimate; oversized input is rejected rather than silently losing source pages.
    const content = request.system + request.input;
    const nonAscii = [...content].filter(char => char.charCodeAt(0) > 127).length;
    const estimate = Math.ceil((content.length - nonAscii) / 3 + nonAscii * 1.5);
    if (estimate + outputBudget + (request.images?.length ?? 0) * 2500 > model.contextWindow) throw new Error('正文、SI、页面图像和记录超过当前模型上下文容量；不会截断原文');
    const result = await ctx.modelRegistry.streamSimple(model, {
      systemPrompt: request.system,
      messages: [{ role: 'user', content: request.images?.length ? [{ type: 'text', text: request.input }, ...await imageContent(ctx.cwd, request.images)] : request.input, timestamp: Date.now() }],
    }, {
      signal: request.signal, maxTokens: outputBudget,
      reasoning: SOL_POLICY.reasoning,
      transport: 'sse',
      timeoutMs: 1200000, maxRetries: 1,
    }).result();
    if (result.stopReason !== 'stop') throw new Error(result.errorMessage ?? `模型未完整返回结果：${result.stopReason}`);
    return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  };
}

const response = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: value });

export function registerDistillationTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'sync_verified_matching', label: '同步已核验金属匹配',
    description: '程序匹配规则修正后，仅按已有GPT核验结论和既有事实重建金属匹配索引，不修改科学草稿，不调用DS或新增科学核验。',
    parameters: Type.Object({ paper_id: id }, { additionalProperties: false }),
    executionMode: 'sequential', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    execute: async (_callId, params, signal, _onUpdate, ctx) => {
      const store = await ExperimentStore.open(ctx.cwd);
      try {
        const expectedState = store.getPaperState(params.paper_id);
        const preferred = store.getPaper(params.paper_id), record = store.getUncertainPaper(params.paper_id) ?? preferred;
        if (!record || record.verification.source_identity !== 'confirmed' || !/^(openai-codex|openai-compat)\/gpt-6\.1-sol:/.test(record.verified_by)) throw new Error('没有来源已确认的GPT-6.1-Sol核验记录');
        signal?.throwIfAborted();
        record.match_entries = matchingEntries(record.draft, record.verification);
        record.candidate_match_entries = matchingEntries(record.draft, record.verification, true)
          .filter(entry => !record.match_entries.some(match => match.sample_local_id === entry.sample_local_id && match.phase_local_id === entry.phase_local_id));
        const run = store.createRun(params.paper_id); run.stage = 'sync_matches'; run.status = record.verification_status === 'uncertain' ? 'published_uncertain' : 'published';
        run.message = `已同步${record.match_entries.length}条经核验的金属集合匹配；科学草稿未改，未调用DS`;
        try {
          await store.saveArtifact(run, 'index_refresh.json', { scientific_changes: 0, deepseek_calls: 0, source_verified_at: record.verified_at, verified_by: record.verified_by });
          await store.saveArtifact(run, 'record.json', deliveryRecord(record));
          signal?.throwIfAborted();
          store.publish(record, expectedState, run);
        } catch (error) {
          run.status = signal?.aborted ? 'cancelled' : 'failed'; run.message = (error as Error).message;
          run.error_kind = signal?.aborted ? 'cancelled' : classifyError(error); store.saveRun(run);
          throw error;
        }
        return response(run);
      } finally { store.close(); }
    },
  });
  pi.registerTool({
    name: 'repair_uncertain_paper', label: '定点修正疑惑记录',
    description: '用户要求继续修正时，从最新疑惑版继续，不重新蒸馏。GPT-6.1-Sol low区分可修正问题与原文限制，只把可修正部分交DS返回字段补丁，保留其他样品与字段。本轮最多3次；工具后复查发现剩余可修正项时，传continue_run_id续接并沿用剩余额度，不重置计数。仅剩真实来源限制时保留说明，仍有实质问题则标记疑惑。',
    parameters: Type.Object({ paper_id: id, feedback: Type.Optional(Type.String()), continue_run_id: Type.Optional(Type.String({ pattern: '^[a-f0-9-]{36}$' })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    execute: async (_callId, params, signal, onUpdate, ctx) => {
      const config = deepSeekConfig();
      let initialRepairAttempts = 0;
      if (params.continue_run_id) {
        const store = await ExperimentStore.openExisting(ctx.cwd);
        try {
          const prior = store?.getRun(params.continue_run_id), seed = store?.getUncertainPaper(params.paper_id);
          if (!prior || prior.paper_id !== params.paper_id || prior.status !== 'published_uncertain' || !seed || Date.parse(seed.verified_at) < Date.parse(prior.started_at) || Date.parse(seed.verified_at) > Date.parse(prior.updated_at)) throw new Error('续接任务与最新疑惑版不一致');
          initialRepairAttempts = seed.repair_rounds ?? 0;
          if (initialRepairAttempts >= 3) throw new Error('本轮定点修正已达到3次上限');
        } finally { store?.close(); }
      }
      return response(await runDistillation(ctx.cwd, { paper_id: params.paper_id }, routeDistillationCalls(createDeepSeekCall(ctx.cwd, config), verificationCall(ctx)), {
        signal, seedUncertain: true, focusedRepairs: true, initialRepairAttempts, requireFeedbackRepair: Boolean(params.continue_run_id), reviewFeedback: params.feedback,
        modelLabel: SOL_LABEL, distillationModelLabel: `deepseek/${config.model}:${config.effort}`,
        onProgress: run => onUpdate?.(response(run)),
      }));
    },
  });
  pi.registerTool({
    name: 'resume_distillation_run', label: '恢复已有DS输出并继续核验返工',
    description: '复用指定任务已返回但解析失败的DS内容，不重复蒸馏。第三次修正只重新解析核验，不再调用DS；首次抽取失败则沿用原记录进入至多3次修正。feedback传入待对照原文核实的既有问题。',
    parameters: Type.Object({ run_id: Type.String({ pattern: '^[a-f0-9-]{36}$' }), feedback: Type.Optional(Type.String()), repair_round: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })), recheck_cached: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    executionMode: 'sequential',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    execute: async (_callId, params, signal, onUpdate, ctx) => {
      const store = await ExperimentStore.openExisting(ctx.cwd);
      const prior = store?.getRun(params.run_id);
      try {
        const resumed = JSON.parse(await readFile(resolve(ctx.cwd, 'data/distillation/runs', params.run_id, 'resumed_run.json'), 'utf8')) as { run_id: string };
        const existing = store?.getRun(resumed.run_id);
        if (!existing) throw new Error('已续接任务的状态缺失，不能重置修正上限');
        if (!(params.recheck_cached && prior?.status === 'published_uncertain')) {
          if (params.feedback !== undefined || params.repair_round !== undefined) throw new Error(`该任务已续接为 ${existing.run_id}；本次 feedback／repair_round 未应用。请针对续接任务继续修正，或使用 recheck_cached 重新核验已有疑惑版`);
          return response(existing);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      } finally { store?.close(); }
      if (!prior || !['published_uncertain', 'failed'].includes(prior.status)) throw new Error('只能恢复已结束且返回过DS内容的解析失败任务');
      const finalRepair = prior.status === 'published_uncertain';
      const selectedRepair = params.repair_round ?? 3;
      if (!finalRepair && params.repair_round) throw new Error('仅已用满修正上限的任务可选择已有修正版本');
      let failed: { message?: string; response?: string; stage?: string; savedDraft?: boolean };
      try {
        failed = JSON.parse(await readFile(resolve(ctx.cwd, 'data/distillation/runs', params.run_id, finalRepair ? `repair_error_${selectedRepair}.json` : 'last_model_output.json'), 'utf8'));
      } catch (error) {
        if (!finalRepair || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        failed = { savedDraft: true, response: await readFile(resolve(ctx.cwd, 'data/distillation/runs', params.run_id, `draft_${selectedRepair}.json`), 'utf8') };
      }
      if (typeof failed.response !== 'string' || (finalRepair ? !failed.savedDraft && !failed.message?.startsWith('模型输出不符合结构') : failed.stage !== 'distill')) throw new Error('没有可恢复的DS解析失败输出');
      if (finalRepair && (parseModelJson(failed.response) as { patches?: unknown }).patches) {
        let baseline;
        for (let round = selectedRepair - 1; round >= 0; round--) {
          try { baseline = JSON.parse(await readFile(resolve(ctx.cwd, 'data/distillation/runs', params.run_id, `draft_${round}.json`), 'utf8')); break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (!baseline) throw new Error('缺少此补丁对应的原始草稿，不能跨版本合并');
        failed.response = JSON.stringify(applyFocusedRepair(failed.response, baseline));
      }
      const config = deepSeekConfig(), verify = verificationCall(ctx), repair = createDeepSeekCall(ctx.cwd, config);
      let additionalCalls = 0;
      const result = await runDistillation(ctx.cwd, { paper_id: prior.paper_id }, request => {
        if (request.stage === 'distill') return Promise.resolve(failed.response!);
        if (request.stage === 'verify') return verify(request);
        if (finalRepair) throw new Error('恢复第三次修正不得再次调用DS');
        additionalCalls++;
        return repair(request);
      }, { signal, maxRepairs: 3, initialRepairAttempts: finalRepair ? 3 : 0, focusedRepairs: true, reviewFeedback: params.feedback, modelLabel: SOL_LABEL, distillationModelLabel: `deepseek/${config.model}:${config.effort}`,
        onProgress: run => onUpdate?.(response(run)) });
      const audit = await ExperimentStore.open(ctx.cwd);
      try {
        await audit.saveArtifact(result, 'recovered_from.json', { run_id: params.run_id, selected_deepseek_round: finalRepair ? selectedRepair : null, initial_repair_attempts: finalRepair ? 3 : 0, additional_deepseek_calls: additionalCalls });
        await audit.saveArtifact(prior, 'resumed_run.json', { run_id: result.run_id });
      }
      finally { audit.close(); }
      return response(result);
    },
  });
  pi.registerTool({
    name: 'distill_paper', label: '论文蒸馏与核验',
    description: '通过 DeepSeek 官方 API 蒸馏，用GPT-6.1-Sol low独立核验完整草稿及实际工具输出；问题自动交给DeepSeek修正，最多3次。通过则确认入库，达到上限仍有问题则选用已核验的最佳可用版本带疑惑标记入库，供检索。',
    promptSnippet: '蒸馏用户指定的论文，并核验和保存实验记录。',
    promptGuidelines: ['仅在用户要求蒸馏或更新指定论文时调用；不要自行批量蒸馏。', 'published_uncertain 表示已入库可检索但存在疑惑，必须展示问题；不能当作完全核验通过。'],
    parameters: DistillInputSchema,
    executionMode: 'sequential',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    execute: async (_callId, params, signal, onUpdate, ctx) => {
      const config = deepSeekConfig();
      const call = routeDistillationCalls(createDeepSeekCall(ctx.cwd, config), verificationCall(ctx));
      const result = await runDistillation(ctx.cwd, params, call, {
        signal, focusedRepairs: true, modelLabel: SOL_LABEL, distillationModelLabel: `deepseek/${config.model}:${config.effort}`,
        onProgress: run => {
          const labels: Record<string, string> = { distill: '抽取制备方法', verify: '核验关键事实', repair: '修正记录' };
          if (ctx.hasUI) ctx.ui.setStatus('spina', `SpinA · ${labels[run.stage] ?? '处理中'}`);
          onUpdate?.(response(run));
        },
      });
      if (ctx.hasUI) ctx.ui.setStatus('spina', '就绪');
      return response(result);
    },
  });

  pi.registerTool({
    name: 'read_paper_pages', label: '提取 PDF 文字和表格',
    description: '按原始 PDF 页码读取文字、布局文本、表格和原页图；扫描页自动 OCR。传 paper_id 或 data/paper 内的 path；可单独读取 SI。每次最多 20 页，不调用蒸馏模型、不入实验库。',
    parameters: Type.Object({
      ...DistillInputSchema.properties,
      paper_id: Type.Optional(id), path: Type.Optional(Type.String({ minLength: 1 })),
      source_id: Type.Optional(Type.String({ pattern: '^src_[1-8]$' })),
      first_page: Type.Optional(Type.Integer({ minimum: 1 })),
      last_page: Type.Optional(Type.Integer({ minimum: 1 })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_callId, params, signal, _onUpdate, ctx) => {
      if (params.path && (params.paper_id || params.sources)) throw new Error('请指定 path 或 paper_id／sources，不能同时指定');
      const prepared = params.path ? { sources: [{ path: params.path }], paper: undefined }
        : params.paper_id ? await resolvePaper(ctx.cwd, { ...params, paper_id: params.paper_id }) : undefined;
      if (!prepared) throw new Error('请提供 paper_id 或 data/paper 内的 path');
      const sources = await readSources(ctx.cwd, prepared.sources, signal, { allowSI: true });
      const source = sources.find(source => source.id === (params.source_id ?? 'src_1'));
      if (!source) throw new Error('指定的 source_id 不存在，请先检查来源');
      const first = params.first_page ?? 1;
      const last = params.last_page ?? Math.min(first + 4, source.pages.length);
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > source.pages.length || last - first >= 20) throw new Error('页码范围无效或超过 20 页');
      const pages = source.pages.filter(page => page.number >= first && page.number <= last);
      await renderSourcePages(ctx.cwd, { ...source, pages }, signal);
      const details = { ...(prepared.paper ? { paper: prepared.paper } : {}), source: { id: source.id, path: source.path, kind: source.kind, page_count: source.pages.length }, pages };
      const content = await imageContent(ctx.cwd, pages.flatMap(page => page.image_path ? [{ path: page.image_path, source_id: source.id, page: page.number }] : []));
      const result = response(details);
      return { ...result, content: [...result.content, ...content] };
    },
  });

  pi.registerTool({
    name: 'inspect_paper_sources', label: '查看论文来源',
    description: '查看指定题录对应的 PDF 来源、正文／SI 分类、页数和首页预览。仅只读检查，不调用蒸馏模型。',
    parameters: DistillInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_callId, params, signal, _onUpdate, ctx) => {
      const prepared = await resolvePaper(ctx.cwd, params);
      const sources = await readSources(ctx.cwd, prepared.sources, signal);
      return response({ paper: prepared.paper, sources: sources.map(source => ({
        id: source.id, path: source.path, kind: source.kind, pages: source.pages.length,
        empty_text_pages: source.pages.filter(page => !page.text.trim()).map(page => page.number),
        preview: source.pages[0].text.slice(0, 1800),
        extraction_methods: [...new Set(source.pages.map(page => page.extraction_method ?? 'pdfjs'))],
        ocr_pages: source.pages.filter(page => page.extraction_method === 'tesseract').map(page => page.number),
        table_pages: source.pages.filter(page => page.tables?.length).map(page => ({ number: page.number, tables: page.tables!.length })),
        warnings: source.pages.flatMap(page => (page.warnings ?? []).map(message => ({ page: page.number, message }))),
      })) });
    },
  });

  pi.registerTool({
    name: 'get_distillation_result', label: '读取蒸馏结果',
    description: '读取已入库实验或按run_id读取状态。展开搜索命中时原样传入record_ref全部字段，版本更新后重新检索。missing_information/source_limitations是论文限制，issues是抽取问题，notes/review_notes是说明和历史记录；历史uncertain状态本身不等于发现错误，也不代表已重新核验。',
    parameters: Type.Object({
      paper_id: Type.Optional(id), run_id: Type.Optional(Type.String({ pattern: '^[a-f0-9-]{36}$' })),
      version: Type.Optional(Type.Union([Type.Literal('preferred'), Type.Literal('verified'), Type.Literal('uncertain')])),
      revision: Type.Optional(Type.Integer({ minimum: 1 })), verified_at: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_callId, params, _signal, _onUpdate, ctx) => {
      if ((!params.paper_id && !params.run_id) || (params.paper_id && params.run_id)) throw new Error('请指定 paper_id 或 run_id 中的一项');
      if (params.run_id && (params.version !== undefined || params.revision !== undefined || params.verified_at !== undefined)) throw new Error('run_id 不能与论文版本参数一起使用');
      const pinned = params.revision !== undefined || params.verified_at !== undefined;
      if (pinned && (params.revision === undefined || !params.verified_at || !params.version || params.version === 'preferred')) throw new Error('锁定记录需要同时提供明确的version、revision和verified_at，请复制搜索结果的record_ref');
      const store = await ExperimentStore.openExisting(ctx.cwd);
      if (!store) {
        if (pinned) throw new Error('检索版本不可用，请重新检索后展开');
        return response(null);
      }
      try {
        if (params.run_id) return response(store.getRun(params.run_id));
        const record = pinned
          ? store.getReferencedPaper({ paper_id: params.paper_id!, version: params.version as RecordReference['version'], revision: params.revision!, verified_at: params.verified_at! })
          : store.getPaper(params.paper_id!, params.version);
        return response(record ? { ...deliveryRecord(record), record_ref: {
          paper_id: record.paper.paper_id, version: record.verification_status ?? 'verified',
          revision: record.revision, verified_at: record.verified_at,
        } } : null);
      }
      finally { store.close(); }
    },
  });

  pi.registerTool({
    name: 'get_sample_preparation', label: '展开样品制备流程',
    description: '按搜索或详情返回的record_ref和sample_id，只读取所选样品及其shared_from祖先，按祖先到自身排列。保留各层原料、步骤顺序、变量、短引文、字段ID和限定及论文级notes；不会自动合并步骤或覆盖条件。由主模型结合各层差异组织具体方法。缺省status表示reported，省略的空字段不代表明确禁止继承；显式未知和note限定必须保留。只读数据库，不调用模型或读取PDF。',
    promptSnippet: '展开一个具体样品的制备方法，取齐其自身和明确共用的祖先流程。',
    promptGuidelines: ['具体展开搜索命中的样品时，复制该条record_ref全部字段和sample_id调用本工具。', '先读论文级notes及各层note，再组织共用步骤和样品差异；不按同名参数或样品数组顺序机械拼接。', '无法确定条件适用步骤时保留限定；子样品明确的未知条件不能被父流程确定值填补。'],
    parameters: Type.Object({
      record_ref: Type.Object({
        paper_id: id, version: Type.Union([Type.Literal('verified'), Type.Literal('uncertain')]),
        revision: Type.Integer({ minimum: 1 }), verified_at: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
      sample_id: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_callId, params, signal, _onUpdate, ctx) =>
      response(await readSamplePreparation(ctx.cwd, params.record_ref, params.sample_id, signal)),
  });

  pi.registerTool({
    name: 'get_preparation_evidence', label: '反查制备字段证据',
    description: '按完整record_ref、目标sample_id和field_path读取库内原始Fact及短引文，不读取PDF或页图。路径以samples.<所属样品ID>开头，后接method、variables.<名称>、materials.<ID>.identity/amount/concentration、phases.<ID>.formula/identity/metal_elements、steps.<ID>.operation/description或steps.<ID>.conditions.<名称>。使用流程输出中的实际ID/名称，不用数组下标。仅允许目标样品及shared_from祖先。fields列表逐项保留source_sample_id、fact及步骤上下文；同名字段有多项时全部返回并标ambiguous=true，不能任取一项。祖先证据不自动证明可用于子样品；has_recorded_content=false表示空默认字段，不能据此断言原文未报告。',
    promptSnippet: '反查一个制备字段的原值、状态、限定及库存短引文。',
    promptGuidelines: ['用户追问某个条件的依据时，先从样品流程定位所属对象，再按实际field_path反查。', '读取fields每项的fact.evidence，仅引用实际保存的quote；同名字段有多项时逐项保留限定，不擅自合并或选择。没有短引文就说明，不能编造或声称新核对过原件。', '结合context判断祖先条件是否适用于子样品；basis=page_image只表示历史取证方式，本次没有打开图像。'],
    parameters: Type.Object({
      record_ref: Type.Object({ paper_id: id,
        version: Type.Union([Type.Literal('verified'), Type.Literal('uncertain')]),
        revision: Type.Integer({ minimum: 1 }), verified_at: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
      sample_id: Type.String({ minLength: 1 }), field_path: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_callId, params, signal, _onUpdate, ctx) =>
      response(await readPreparationEvidence(ctx.cwd, params.record_ref, params.sample_id, params.field_path, signal)),
  });

  pi.registerTool({
    name: 'search_spinel_experiments', label: '检索尖晶石制备实验',
    description: '按目标相金属集合检索，返回results、total、next_offset和has_more。默认exact，related提示含额外金属的体系，superset可分页查看补充案例。method_summary列大纲，record_ref绑定版本。missing_information/source_limitations在回答中体现，只有issues标抽取问题；certainty是存储版本，不直接作为疑惑判断。possible=true始终只表示可能匹配。total按版本/样品/相计数。',
    parameters: Type.Object({
      metal_elements: Type.Array(Type.String({ pattern: '^[A-Z][a-z]?$' }), { minItems: 1, maxItems: 12 }),
      include_uncertain: Type.Optional(Type.Boolean({ default: true, description: '默认 true：包含历史待核对版本和可能匹配；false 同时排除两类。' })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      match: Type.Optional(Type.Union([Type.Literal('exact'), Type.Literal('superset')])),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_callId, params, _signal, _onUpdate, ctx) => {
      const store = await ExperimentStore.openExisting(ctx.cwd);
      if (!store) return response({
        metal_elements: [...new Set(params.metal_elements)].sort(), match: params.match ?? 'exact',
        total: 0, offset: params.offset ?? 0, limit: params.limit ?? 20, has_more: false, next_offset: null, results: [],
        related: { total: 0, uncertain: 0, possible: 0, metal_sets: [] },
      });
      try { return response(store.searchByElements(params.metal_elements, {
        includeUncertain: params.include_uncertain, limit: params.limit, offset: params.offset, match: params.match,
      })); }
      finally { store.close(); }
    },
  });

  pi.registerTool({
    name: 'search_preparation_conditions', label: '跨库筛选制备条件',
    description: '只读库内结构化记录，温度/时长/原料至少提供一种；step_terms仅作附加过滤，不能单独检索步骤词。temperature输入为°C；duration默认h，可s/min/h/d，至少给min或max，边界默认包含。单值常见单位自动比较；范围、未知、多值、继承及限定进入needs_review。step_terms按步骤ID/操作/描述OR匹配，搭配原料条件同样生效。原料组间AND，别名组内OR；not_listed仅表示库内未列出。include_uncertain默认true，包含待核对版本及可能匹配，false同时排除两类。可附金属exact或严格superset。total按版本/样品计数，field_matches是字段支持数，needs_review另计；均须展开后核对适用范围。返回record_ref和字段证据分页；unevaluable_samples表示无可比较字段，不能当作不符合。',
    promptSnippet: '跨论文按已记录温度、时长、原料筛选可展开核对的制备候选。',
    promptGuidelines: ['温度和时长默认要求出现在同一步骤；不能把干燥温度与另一煅烧步骤的时长拼成命中。', '字段命中不等于整条路线最高温度或总时长满足；需按record_ref和sample_id调用get_sample_preparation展开，再按需反查。', 'not_listed不能答成实际未使用。报告field_matches、needs_review和unevaluable_samples，分页未读完不得声称列全。'],
    parameters: PreparationConditionQuerySchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_callId, params, signal, _onUpdate, ctx) => response(await searchPreparationConditions(ctx.cwd, params, signal)),
  });

  pi.registerCommand('distill', {
    description: '蒸馏一篇论文：/distill SPINA-0100，或 /distill {JSON 参数}',
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) { ctx.ui.notify('用法：/distill SPINA-0100；新论文可提供包含 paper_id、doi、title、sources 的 JSON 参数。', 'info'); return; }
      let input: unknown;
      try { input = raw.startsWith('{') ? JSON.parse(raw) : { paper_id: raw }; }
      catch { ctx.ui.notify('参数不是有效 JSON。', 'error'); return; }
      if (!Check(DistillInputSchema, input)) { ctx.ui.notify('参数格式无效，请提供正确 paper_id；新论文还需要 doi、title 和 sources。', 'error'); return; }
      // Execute as a normal agent tool turn so Esc uses Pi's native cancellation signal.
      await pi.sendUserMessage(`请调用 distill_paper 对下列用户指定论文执行蒸馏与核验。只处理这一篇，并报告实际任务状态：\n${JSON.stringify(input)}`);
    },
  });
}
