import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ExperimentStore } from './distillation/store.ts';
import { ResearchStore, SPECIMEN_RELATION_TYPES, type Observation, type SpecimenRelation } from './research/store.ts';
import { makeArtifact, newId, nowIso, planResearchTask, TASK_TYPES, type SubjectRef } from './research/contracts.ts';
import { resolveMaterialIdentity, relateMaterials } from './research/materials.ts';
import { buildSpecimenLineage } from './research/specimens.ts';
import { checkEvidenceContinuity } from './research/continuity.ts';
import { analyzeSampleSeries } from './research/study-design.ts';
import { explainDisagreement, validateClaim, type ClaimInput } from './research/claims.ts';
import { identifyDiscriminatingObservations, validateHypothesis, type HypothesisInput } from './research/hypotheses.ts';
import { prepareComputationSpec } from './research/computation.ts';
import { extractTableObservations, toObservation } from './research/facets/observations.ts';
import { readSources } from './distillation/documents.ts';
import { resolveSample } from './research/adapters/preparation-reader.ts';

/**
 * Model-facing entry points for the research layer.
 *
 * These tools are thin adapters: all scientific logic lives in `src/research/`. Every call
 * records an artifact with provenance, so a model interpretation can never masquerade as a
 * paper fact.
 */

const id = Type.String({ pattern: '^[A-Za-z0-9_-]{1,80}$' });
const version = Type.Optional(Type.Union([Type.Literal('verified'), Type.Literal('uncertain')]));
const SubjectSchema = Type.Object({
  paper_id: id,
  sample_id: Type.Optional(Type.String({ minLength: 1 })),
  phase_id: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const response = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: value });

async function withStores<T>(ctx: ExtensionContext, run: (knowledge: ExperimentStore, research: ResearchStore) => Promise<T> | T): Promise<T> {
  const knowledge = await ExperimentStore.openExisting(ctx.cwd);
  if (!knowledge) throw new Error('工作库不存在：研究分析需要已入库的制备记录');
  const research = await ResearchStore.open(ctx.cwd);
  try { return await run(knowledge, research); }
  finally { knowledge.close(); research.close(); }
}

function sampleOf(knowledge: ExperimentStore, paperId: string, sampleId: string | undefined, chosen?: 'verified' | 'uncertain') {
  const resolved = resolveSample(knowledge, paperId, sampleId, chosen);
  if (!resolved.sampleId) {
    if (resolved.record.draft.samples.length !== 1) throw new Error(`该论文有多个样品，请指定 sample_id：${resolved.record.draft.samples.slice(0, 20).map(sample => sample.local_id).join('、')}`);
    return { ...resolved, sampleId: resolved.record.draft.samples[0].local_id };
  }
  return { ...resolved, sampleId: resolved.sampleId };
}

export function registerResearchTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'plan_research_task',
    label: '规划研究分析任务',
    description: '把多步研究问题编译成有依赖的计划：材料身份、样品状态、系列分析、论断分歧、竞争假设、计算准备。返回就绪状态、未满足输入、需要的信息域与模型步骤。简单检索不要调用本工具，直接用现有检索工具。',
    parameters: Type.Object({
      task_type: Type.Union(TASK_TYPES.map(item => Type.Literal(item))),
      question: Type.String({ minLength: 1 }),
      subjects: Type.Optional(Type.Array(SubjectSchema, { maxItems: 20 })),
      requested_outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_callId, params) => response(planResearchTask({
      task_type: params.task_type as (typeof TASK_TYPES)[number],
      question: params.question,
      subject_refs: (params.subjects ?? []) as SubjectRef[],
      requested_outputs: params.requested_outputs,
    })),
  });

  pi.registerTool({
    name: 'resolve_material_identity',
    label: '解析材料身份',
    description: '按元素集合、计量组成、结构表述和样品状态分层描述材料身份。确定化学式由程序解析；变量化学式保留符号与定义域，不强行变成单一组成。化学式相同不等于晶型或阳离子占位相同，结构未由原文标注时标为未确认。产物写入研究库，不修改制备记录。',
    parameters: Type.Object({
      paper_id: id, sample_id: Type.Optional(Type.String({ minLength: 1 })),
      phase_id: Type.Optional(Type.String({ minLength: 1 })), version,
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute: async (_callId, params, _signal, _onUpdate, ctx) => withStores(ctx, (knowledge, research) => {
      const resolved = sampleOf(knowledge, params.paper_id, params.sample_id, params.version as 'verified' | 'uncertain' | undefined);
      const identity = resolveMaterialIdentity(resolved.record, resolved.version, resolved.sampleId, params.phase_id);
      const artifact = makeArtifact({ kind: 'material_identity', provenance: 'deterministic_analysis', inputs: [identity.subject], data: identity, unresolved: identity.unresolved });
      research.saveArtifact(artifact);
      return response({ artifact_id: artifact.artifact_id, identity });
    }),
  });

  pi.registerTool({
    name: 'relate_material_entities',
    label: '判断两个材料对象的关联',
    description: '分层给出两个材料身份在元素集合、计量组成、结构身份和是否同一样品上的关系；不使用单一相似度分数。元素集合相同但计量不同会明确报告，变量组成只判同族。需要两个已定位样品。',
    parameters: Type.Object({
      left: Type.Object({ paper_id: id, sample_id: Type.String({ minLength: 1 }), phase_id: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
      right: Type.Object({ paper_id: id, sample_id: Type.String({ minLength: 1 }), phase_id: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
      version,
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute: async (_callId, params, _signal, _onUpdate, ctx) => withStores(ctx, (knowledge, research) => {
      const resolve = (subject: { paper_id: string; sample_id: string; phase_id?: string }) => {
        const resolved = resolveSample(knowledge, subject.paper_id, subject.sample_id, params.version as 'verified' | 'uncertain' | undefined);
        return resolveMaterialIdentity(resolved.record, resolved.version, subject.sample_id, subject.phase_id);
      };
      const left = resolve(params.left), right = resolve(params.right);
      const relation = relateMaterials(left, right);
      const artifact = makeArtifact({ kind: 'material_relation', provenance: 'deterministic_analysis', inputs: [left.subject, right.subject], data: relation, unresolved: relation.unresolved });
      research.saveArtifact(artifact);
      return response({ artifact_id: artifact.artifact_id, relation });
    }),
  });

  pi.registerTool({
    name: 'build_specimen_lineage',
    label: '构建样品状态谱系',
    description: '区分制备继承、分装、负载、后处理与测试后状态。shared_from 只作为 preparation_inherits 边，绝不自动当作物理转化或因果。只有显式登记的 specimen_relations 和观察才成为状态边；没有记录时返回未解决项，不按样品名猜测。',
    parameters: Type.Object({ paper_id: id, sample_id: Type.String({ minLength: 1 }), version }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute: async (_callId, params, _signal, _onUpdate, ctx) => withStores(ctx, (knowledge, research) => {
      const resolved = resolveSample(knowledge, params.paper_id, params.sample_id, params.version as 'verified' | 'uncertain' | undefined);
      const graph = buildSpecimenLineage(resolved.record, resolved.version, research, params.sample_id);
      const artifact = makeArtifact({ kind: 'specimen_graph', provenance: 'deterministic_analysis', inputs: [{ paper_id: params.paper_id, sample_id: params.sample_id }], data: graph, unresolved: graph.unresolved });
      research.saveArtifact(artifact);
      return response({ artifact_id: artifact.artifact_id, graph });
    }),
  });

  pi.registerTool({
    name: 'analyze_sample_series',
    label: '分析论文内样品系列',
    description: '比较同一论文内样品实际改变了哪些变量、哪些条件保持一致、哪些未报告或名称未对齐，并连接已登记的结果观察。多个变量同时改变时明确输出“不能单独归因于某一个变量”。空字段按未报告处理，不当作控制变量一致；不跨论文合并，不估计因果效应。',
    parameters: Type.Object({
      paper_id: id, control: Type.Optional(Type.String({ minLength: 1 })),
      samples: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 30 })),
      version,
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute: async (_callId, params, _signal, _onUpdate, ctx) => withStores(ctx, (knowledge, research) => {
      const resolved = resolveSample(knowledge, params.paper_id, params.control, params.version as 'verified' | 'uncertain' | undefined);
      const contrast = analyzeSampleSeries(resolved.record, resolved.version, research, { control: params.control, samples: params.samples });
      const artifact = makeArtifact({ kind: 'study_contrast', provenance: 'deterministic_analysis', inputs: [{ paper_id: params.paper_id }], data: contrast, unresolved: contrast.unresolved });
      research.saveArtifact(artifact);
      return response({ artifact_id: artifact.artifact_id, contrast });
    }),
  });

  pi.registerTool({
    name: 'explain_claim_disagreement',
    label: '解释科学论断分歧',
    description: '先对齐主体、材料状态与适用范围，再判断是否真冲突。区分：真正分歧、范围未对齐、主体不同、证据层次不同（观察 vs 解释）、引用而非独立支持。独立支持按来源家族计数，引用不累加。论断需先用 record_research_objects 登记 topic、kind、stance 与范围。',
    parameters: Type.Object({
      paper_id: Type.Optional(id), topic: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute: async (_callId, params, _signal, _onUpdate, ctx) => withStores(ctx, (_knowledge, research) => {
      let claims = research.listClaims(params.paper_id);
      const topic = params.topic;
      if (topic) claims = claims.filter(claim => claim.topic === topic.normalize('NFKC').toLowerCase());
      if (!claims.length) throw new Error('没有登记可比较的论断；先用 record_research_objects 登记带 topic 的论断');
      const graph = explainDisagreement(claims);
      const artifact = makeArtifact({ kind: 'claim_graph', provenance: 'deterministic_analysis', inputs: [...new Set(claims.map(claim => claim.paper_id))].map(paper_id => ({ paper_id })), data: graph, unresolved: graph.unresolved });
      research.saveArtifact(artifact);
      return response({ artifact_id: artifact.artifact_id, graph });
    }),
  });

  pi.registerTool({
    name: 'check_evidence_continuity',
    label: '检查跨版本证据连续性',
    description: '论文重新蒸馏后，判断已登记观察与样品关系是否仍对应当前修订的实验样品。比较样品 ID 与目标相化学指纹，输出 same_specimen（ID 与指纹均未变）、relabelled（ID 变了但化学指纹唯一匹配）、redefined（ID 未变但化学指纹变化）、missing、unverifiable、current。指纹只证明记录一致，不证明同一物理批次；redefined 与 missing 的旧观察不能沿用。',
    parameters: Type.Object({ paper_id: id, version }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute: async (_callId, params, _signal, _onUpdate, ctx) => withStores(ctx, (knowledge, research) => {
      const resolved = resolveSample(knowledge, params.paper_id, undefined, params.version as 'verified' | 'uncertain' | undefined);
      const report = checkEvidenceContinuity(resolved.record, resolved.version, research);
      const artifact = makeArtifact({
        kind: 'evidence_continuity', provenance: 'deterministic_analysis',
        inputs: [{ paper_id: params.paper_id }], data: report, unresolved: report.unresolved,
      });
      research.saveArtifact(artifact);
      return response({ artifact_id: artifact.artifact_id, report });
    }),
  });

  pi.registerTool({
    name: 'extract_paper_observations',
    label: '从论文表格抽取观测',
    description: '按指定指标读取论文表格，把数值、单位、样品标签、测量方法和条件配对到已入库样品，并绑定当前记录修订版。只接受表格中真实存在的数值；无法配对的标签、n.r. 等会单独列出，不静默丢弃。至少两个样品时自动做系列可比性判断与差值。需要 data/paper 中的原件和 pdfplumber 表格提取。',
    promptSnippet: '从一篇论文的表格中抽取一个指标，并比较两个样品的数值与可比性。',
    promptGuidelines: ['用户要求“从这篇论文的表格取某个指标并比较样品”时使用；先确认指标名与记录样品能对上。', 'unmatched_labels 必须原样报告，不能猜一个样品；unit/method/context 缺失时不要补默认值。', 'comparison 的 incomparable 表示不能建立定量对比，不能只报差值。'],
    parameters: Type.Object({
      paper_id: id,
      metric: Type.String({ minLength: 1, description: '指标键或表头文字，例如 h2_evolution_rate、H2 evolution rate' }),
      samples: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
      table_index: Type.Optional(Type.Integer({ minimum: 0 })),
      sample_map: Type.Optional(Type.Record(Type.String(), Type.String())),
      save: Type.Optional(Type.Boolean({ default: true })),
      version,
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute: async (_callId, params, signal, _onUpdate, ctx) => withStores(ctx, async (knowledge, research) => {
      const resolved = resolveSample(knowledge, params.paper_id, undefined, params.version as 'verified' | 'uncertain' | undefined);
      const sources = resolved.record.sources.map(source => ({ path: source.path, kind: source.kind }));
      if (!sources.length) throw new Error('该记录没有来源文件，无法读取表格');
      const documents = await readSources(ctx.cwd, sources, signal, { allowSI: true });
      const extraction = extractTableObservations(resolved.record, documents, {
        metric: params.metric, samples: params.samples, table_index: params.table_index,
        sample_map: params.sample_map, version: resolved.version,
      });
      const saved: string[] = [];
      if (params.save !== false) for (const candidate of extraction.candidates) { research.addObservation(toObservation(candidate)); saved.push(candidate.observation_id); }
      const sampleIds = [...new Set(extraction.candidates.map(candidate => candidate.sample_id))];
      const comparison = sampleIds.length >= 2 && params.save !== false
        ? analyzeSampleSeries(resolved.record, resolved.version, research, { samples: sampleIds })
        : null;
      return response({ extraction, saved, comparison });
    }),
  });

  pi.registerTool({
    name: 'prepare_computation_spec',
    label: '准备结构计算任务',
    description: '读取 CIF/POSCAR，检查晶胞、位点与组成，输出可交接的计算任务规范：问题、可观测量、候选结构、需决定参数、预期输出。未指定的泛函、赝势、U 值、磁构型与 k 点不会被默认固定；没有结构文件时只输出结构需求清单，不编造晶格与坐标。这是任务准备，不是计算完成。',
    parameters: Type.Object({
      question: Type.String({ minLength: 1 }), observable: Type.String({ minLength: 1 }),
      structures: Type.Optional(Type.Array(Type.Object({
        path: Type.String({ minLength: 1 }),
        expected_formula: Type.Optional(Type.String({ minLength: 1 })),
        label: Type.Optional(Type.String({ minLength: 1 })),
        source: Type.Optional(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }), { maxItems: 8 })),
      hypotheses: Type.Optional(Type.Array(Type.Object({
        hypothesis_id: Type.Optional(Type.String({ minLength: 1 })),
        statement: Type.String({ minLength: 1 }),
        predicts: Type.Optional(Type.Array(Type.Object({ observable: Type.String({ minLength: 1 }), expected: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { maxItems: 8 })),
      }, { additionalProperties: false }), { maxItems: 8 })),
      fixed_parameters: Type.Optional(Type.Record(Type.String(), Type.String())),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute: async (_callId, params, _signal, _onUpdate, ctx) => withStores(ctx, async (_knowledge, research) => {
      const spec = await prepareComputationSpec(ctx.cwd, {
        question: params.question, observable: params.observable,
        structures: params.structures, hypotheses: params.hypotheses,
        fixed_parameters: params.fixed_parameters,
      });
      const artifact = makeArtifact({ kind: 'computation_spec', provenance: 'deterministic_analysis', inputs: [], data: spec, warnings: spec.warnings, unresolved: spec.unresolved });
      research.saveArtifact(artifact);
      return response({ artifact_id: artifact.artifact_id, spec });
    }),
  });

  pi.registerTool({
    name: 'record_research_objects',
    label: '登记研究输入对象',
    description: '登记显式的样品关系、结果观察、科学论断和竞争假设。论断必须带 topic、kind、stance 与范围；作者观察必须有直接观察/证据支撑；系统假设的 origin_family 以 system: 开头。假设必须有至少一个可反驳条件，否则拒绝登记。这里写入的是研究输入，不是论文事实，也不修改制备记录。',
    parameters: Type.Object({
      specimen_relations: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()), { maxItems: 100 })),
      observations: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()), { maxItems: 200 })),
      claims: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()), { maxItems: 200 })),
      hypotheses: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()), { maxItems: 50 })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute: async (_callId, params, _signal, _onUpdate, ctx) => withStores(ctx, (knowledge, research) => {
      // Validate model-authored objects first; nothing is written if one contract fails.
      const validatedClaims = (params.claims ?? []).map(claim => validateClaim(claim as unknown as ClaimInput));
      const validatedHypotheses = (params.hypotheses ?? []).map(hypothesis => validateHypothesis(hypothesis as unknown as HypothesisInput));
      const counts = { specimen_relations: 0, observations: 0, claims: 0, hypotheses: 0 };
      research.transaction(() => {
        for (const [index, relation] of (params.specimen_relations ?? []).entries()) {
          const relationType = String(relation.relation ?? '');
          if (!SPECIMEN_RELATION_TYPES.includes(relationType as (typeof SPECIMEN_RELATION_TYPES)[number])) throw new Error(`specimen_relations[${index}].relation 必须为 ${SPECIMEN_RELATION_TYPES.join('、')}`);
          const paperId = String(relation.paper_id ?? '');
          const from = String(relation.from ?? ''), to = String(relation.to ?? '');
          if (!paperId || !from.includes('::') || !to.includes('::')) throw new Error(`specimen_relations[${index}] 需要 paper_id 与 from/to 样品 ID（论文ID::样品ID）`);
          if (!String(relation.note ?? '').trim()) throw new Error(`specimen_relations[${index}] 需要 note 说明关系依据`);
          for (const specimen of [from, to]) {
            const local = specimen.split('::')[1];
            if (!local || specimen !== `${paperId}::${local}`) throw new Error(`样品 ID 与论文不一致：${specimen}`);
            try { resolveSample(knowledge, paperId, local); }
            catch { throw new Error(`specimen_relations[${index}] 的样品不在该论文中：${specimen}`); }
          }
          const stored: SpecimenRelation = {
            relation_id: String(relation.relation_id ?? newId('srel')), paper_id: paperId,
            from_specimen: from, to_specimen: to,
            relation: relationType as SpecimenRelation['relation'],
            evidence: Array.isArray(relation.evidence) ? relation.evidence : [],
            note: String(relation.note), created_at: nowIso(),
          };
          research.addSpecimenRelation(stored); counts.specimen_relations++;
        }
        for (const [index, observation] of (params.observations ?? []).entries()) {
          const paperId = String(observation.paper_id ?? ''), sampleId = String(observation.sample_id ?? '');
          if (!paperId || !sampleId || !observation.metric) throw new Error(`observations[${index}] 需要 paper_id、sample_id、metric`);
          if (observation.value === undefined || observation.value === null) throw new Error(`observations[${index}] 需要 value`);
          try { resolveSample(knowledge, paperId, sampleId); }
          catch { throw new Error(`observations[${index}] 的论文或样品不在库中：${paperId} / ${sampleId}`); }
          const stored: Observation = {
            observation_id: String(observation.observation_id ?? newId('obs')), paper_id: paperId, sample_id: sampleId,
            metric: String(observation.metric), value: observation.value as string | number,
            unit: observation.unit ? String(observation.unit) : null, method: observation.method ? String(observation.method) : null,
            context: (observation.context ?? {}) as Record<string, string>,
            evidence: Array.isArray(observation.evidence) ? observation.evidence : [],
            provenance: 'source_reported', created_at: nowIso(),
          };
          research.addObservation(stored); counts.observations++;
        }
        for (const claim of validatedClaims) { research.addClaim(claim); counts.claims++; }
        for (const hypothesis of validatedHypotheses) { research.addHypothesis(hypothesis); counts.hypotheses++; }
      });
      return response({ recorded: counts, note: '研究输入已写入 data/research，不修改论文记录；论断与假设保留来源类型。' });
    }),
  });

  pi.registerTool({
    name: 'identify_discriminating_observations',
    label: '寻找区分性观察',
    description: '对已登记的竞争假设做确定性区分：找出两条假设预期不同的同一可观测量。没有共同观察或预期相同时，明确输出“现有信息不能区分”，不升级为已证明。拒绝没有可反驳条件的假设。',
    parameters: Type.Object({ hypothesis_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 12 })) }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute: async (_callId, params, _signal, _onUpdate, ctx) => withStores(ctx, (_knowledge, research) => {
      const all = research.listHypotheses();
      const hypotheses = params.hypothesis_ids?.length ? all.filter(item => params.hypothesis_ids!.includes(item.hypothesis_id)) : all;
      if (hypotheses.length < 2) throw new Error('至少需要两条已登记假设；先用 record_research_objects 登记');
      const result = identifyDiscriminatingObservations(hypotheses);
      const artifact = makeArtifact({ kind: 'hypothesis_set', provenance: 'model_hypothesis', inputs: [], data: { hypotheses, discrimination: result }, unresolved: result.unresolved, warnings: ['假设由模型或用户提供；区分性观察为确定性分析，不代表假设成立。'] });
      research.saveArtifact(artifact);
      return response({ artifact_id: artifact.artifact_id, result });
    }),
  });
}
