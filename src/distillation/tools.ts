import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ModelCall } from './agents.ts';
import { runDistillation, matchingEntries } from './pipeline.ts';
import { ExperimentStore, deliveryRecord } from './store.ts';
import { resolvePaper, readSources } from './documents.ts';
import { imageContent } from './images.ts';
import { createDeepSeekCall, deepSeekConfig, routeDistillationCalls } from './deepseek.ts';
import { SOL_POLICY, SOL_LABEL } from '../model-policy.ts';
import { applyFocusedRepair, parseModelJson } from './schema.ts';

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
        const preferred = store.getPaper(params.paper_id), record = store.getUncertainPaper(params.paper_id) ?? preferred;
        if (!record || record.verification.source_identity !== 'confirmed' || !/^(openai-codex|openai-compat)\/gpt-6\.1-sol:/.test(record.verified_by)) throw new Error('没有来源已确认的GPT-6.1-Sol核验记录');
        signal?.throwIfAborted();
        record.match_entries = matchingEntries(record.draft, record.verification);
        if (record.verification_status === 'uncertain') record.candidate_match_entries = matchingEntries(record.draft, record.verification, true)
          .filter(entry => !record.match_entries.some(match => match.sample_local_id === entry.sample_local_id && match.phase_local_id === entry.phase_local_id));
        store.publish(record, preferred!.revision);
        const run = store.createRun(params.paper_id); run.stage = 'sync_matches'; run.status = record.verification_status === 'uncertain' ? 'published_uncertain' : 'published';
        run.message = `已同步${record.match_entries.length}条经核验的金属集合匹配；科学草稿未改，未调用DS`;
        await store.saveArtifact(run, 'index_refresh.json', { scientific_changes: 0, deepseek_calls: 0, source_verified_at: record.verified_at, verified_by: record.verified_by });
        await store.saveArtifact(run, 'record.json', deliveryRecord(record)); store.saveRun(run);
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
        if (!(params.recheck_cached && prior?.status === 'published_uncertain')) return response(existing);
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
      const sources = await readSources(ctx.cwd, prepared.sources, signal, { renderImages: true, allowSI: true });
      const source = sources.find(source => source.id === (params.source_id ?? 'src_1'));
      if (!source) throw new Error('指定的 source_id 不存在，请先检查来源');
      const first = params.first_page ?? 1;
      const last = params.last_page ?? Math.min(first + 4, source.pages.length);
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > source.pages.length || last - first >= 20) throw new Error('页码范围无效或超过 20 页');
      const pages = source.pages.filter(page => page.number >= first && page.number <= last);
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
    description: '读取已入库实验，包括带疑惑标记的记录，或按run_id读取状态。默认优先确认版本，无确认版本时返回疑惑版本；version=uncertain可指定读取疑惑版本。疑惑记录不能宣称已完全核验通过。',
    parameters: Type.Object({ paper_id: Type.Optional(id), run_id: Type.Optional(Type.String({ pattern: '^[a-f0-9-]{36}$' })), version: Type.Optional(Type.Union([Type.Literal('preferred'), Type.Literal('uncertain')])) }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_callId, params, _signal, _onUpdate, ctx) => {
      if ((!params.paper_id && !params.run_id) || (params.paper_id && params.run_id)) throw new Error('请指定 paper_id 或 run_id 中的一项');
      const store = await ExperimentStore.openExisting(ctx.cwd);
      if (!store) return response(null);
      try {
        if (params.run_id) return response(store.getRun(params.run_id));
        const record = params.version === 'uncertain' ? store.getUncertainPaper(params.paper_id!) : store.getPaper(params.paper_id!);
        return response(record ? deliveryRecord(record) : null);
      }
      finally { store.close(); }
    },
  });

  pi.registerTool({
    name: 'search_spinel_experiments', label: '检索尖晶石制备实验',
    description: '按目标相金属元素集合恰好匹配已入库实验。默认包含疑惑记录，返回certainty和possible标记及问题；possible=true只表示可能匹配，不能当成确定匹配。',
    parameters: Type.Object({ metal_elements: Type.Array(Type.String({ pattern: '^[A-Z][a-z]?$' }), { minItems: 1, maxItems: 12 }), include_uncertain: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_callId, params, _signal, _onUpdate, ctx) => {
      const store = await ExperimentStore.openExisting(ctx.cwd);
      if (!store) return response([]);
      try { return response(store.searchByElements(params.metal_elements, params.include_uncertain ?? true, params.limit ?? 20)); }
      finally { store.close(); }
    },
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
