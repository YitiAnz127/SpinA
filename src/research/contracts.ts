import { randomUUID } from 'node:crypto';

/**
 * Contracts for the research layer.
 *
 * These objects are deliberately separate from the preparation records: a research artifact
 * is an analysis result with an explicit provenance, never a paper fact. Nothing here writes
 * back into `papers` / `uncertain_papers`.
 */

export const PROVENANCE_KINDS = ['source_reported', 'deterministic_analysis', 'model_interpretation', 'model_hypothesis', 'simulation_result'] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

export const PROVENANCE_LABELS: Record<ProvenanceKind, string> = {
  source_reported: '原文报告',
  deterministic_analysis: '确定性分析',
  model_interpretation: '模型解释',
  model_hypothesis: '系统假设',
  simulation_result: '计算结果',
};

export const ARTIFACT_KINDS = ['material_identity', 'material_relation', 'specimen_graph', 'study_contrast', 'claim_graph', 'hypothesis_set', 'structure_artifact', 'computation_spec', 'evidence_continuity'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  material_identity: '材料身份卡',
  material_relation: '材料关联',
  specimen_graph: '样品状态谱系',
  study_contrast: '样品系列对照',
  claim_graph: '科学论断图',
  hypothesis_set: '竞争假设集',
  structure_artifact: '结构文件',
  computation_spec: '计算任务规范',
  evidence_continuity: '跨版本证据连续性',
};

export const FACETS = ['material_identity', 'study_design', 'observations', 'claims', 'structures'] as const;
export type FacetName = (typeof FACETS)[number];

export const FACET_LABELS: Record<FacetName, string> = {
  material_identity: '材料身份',
  study_design: '系列实验设计',
  observations: '结果观察',
  claims: '作者论断',
  structures: '结构来源',
};

export interface SubjectRef {
  paper_id: string;
  sample_id?: string;
  phase_id?: string;
  /** Controlled material label used to align claims across papers (e.g. NiCo2O4). */
  material?: string;
  claim_id?: string;
  hypothesis_id?: string;
  structure_id?: string;
}

export interface ResearchArtifact<T = unknown> {
  schema_version: 1;
  artifact_id: string;
  kind: ArtifactKind;
  provenance: ProvenanceKind;
  created_at: string;
  task_id?: string;
  inputs: SubjectRef[];
  warnings: string[];
  unresolved: string[];
  data: T;
}

export const newId = (prefix: string) => `${prefix}_${randomUUID()}`;
export const nowIso = () => new Date().toISOString();

const ARTIFACT_PREFIXES: Record<ArtifactKind, string> = {
  material_identity: 'mat', material_relation: 'rel', specimen_graph: 'spec',
  study_contrast: 'study', claim_graph: 'claimg', hypothesis_set: 'hyp',
  structure_artifact: 'struct', computation_spec: 'comp', evidence_continuity: 'cont',
};

/** Wrap an analysis result with its provenance, inputs and explicit unresolved items. */
export function makeArtifact<T>(input: {
  kind: ArtifactKind; provenance: ProvenanceKind; inputs: SubjectRef[];
  data: T; warnings?: string[]; unresolved?: string[]; task_id?: string;
}): ResearchArtifact<T> {
  return {
    schema_version: 1, artifact_id: newId(ARTIFACT_PREFIXES[input.kind]), kind: input.kind,
    provenance: input.provenance, created_at: nowIso(),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    inputs: input.inputs, warnings: input.warnings ?? [], unresolved: input.unresolved ?? [], data: input.data,
  };
}

/** A subject ref must at least name a paper; sample/phase refine it. */
export function normalizeSubjectRef(value: SubjectRef): SubjectRef {
  if (!value || typeof value.paper_id !== 'string' || !value.paper_id.trim()) throw new Error('subject_ref 需要 paper_id');
  const ref: SubjectRef = { paper_id: value.paper_id.trim() };
  for (const key of ['sample_id', 'phase_id', 'claim_id', 'hypothesis_id', 'structure_id', 'material'] as const) {
    const item = value[key];
    if (item !== undefined && item !== null) {
      if (typeof item !== 'string' || !item.trim()) throw new Error(`subject_ref.${key} 不能为空`);
      ref[key] = item.trim();
    }
  }
  return ref;
}

export const subjectKey = (ref: SubjectRef) => [ref.paper_id, ref.sample_id ?? '', ref.phase_id ?? ''].join('::');

export const TASK_TYPES = ['material_identity', 'material_relation', 'specimen_lineage', 'series_analysis', 'claim_disagreement', 'hypothesis_analysis', 'computation_preparation'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_LABELS: Record<TaskType, string> = {
  material_identity: '材料身份解析',
  material_relation: '材料关联判断',
  specimen_lineage: '样品状态追踪',
  series_analysis: '论文内系列分析',
  claim_disagreement: '科学论断分歧',
  hypothesis_analysis: '竞争假设分析',
  computation_preparation: '结构计算准备',
};

export interface ResearchTask {
  task_type: TaskType;
  question: string;
  subject_refs: SubjectRef[];
  requested_outputs?: string[];
  assumptions?: string[];
  required_facets?: FacetName[];
}

/**
 * Tool contracts, following the "scientific applicability" idea: a tool declares what it
 * accepts, what it does not, and what kind of result it produces.
 */
export interface CapabilityContract {
  name: string;
  input_type: string;
  output_type: string;
  preconditions: string[];
  scientific_scope: string;
  unsupported_cases: string[];
  result_kind: 'parsed' | 'derived_analysis' | 'model_interpretation' | 'model_hypothesis' | 'simulation_result';
  deterministic: boolean;
}

export const CAPABILITIES: Record<string, CapabilityContract> = {
  resolve_material_identity: {
    name: 'resolve_material_identity',
    input_type: 'record_ref + sample_id（或 phase_id）',
    output_type: 'MaterialIdentity',
    preconditions: ['目标相或样品的化学式字段可读'],
    scientific_scope: '按元素集合、计量组成、结构表述和样品状态分层描述材料身份；不判断纯相或占位',
    unsupported_cases: ['化学式缺失或无法解析', '需要实测组成但记录中没有', '需要晶体结构但没有 CIF/结构库来源'],
    result_kind: 'parsed',
    deterministic: true,
  },
  relate_material_entities: {
    name: 'relate_material_entities',
    input_type: '两个 MaterialIdentity',
    output_type: 'MaterialRelation',
    preconditions: ['两个对象都已解析出至少元素集合'],
    scientific_scope: '分层给出相同/不同/无证据，不用单一相似度分数代替判断',
    unsupported_cases: ['任一方化学式无法解析时只能给元素层或未知'],
    result_kind: 'derived_analysis',
    deterministic: true,
  },
  build_specimen_lineage: {
    name: 'build_specimen_lineage',
    input_type: 'record_ref + sample_id',
    output_type: 'SpecimenGraph',
    preconditions: ['样品存在'],
    scientific_scope: '区分制备继承、分装、负载、后处理与测试后状态；只使用显式记录',
    unsupported_cases: ['未记录的物理转化关系不能由样品名或 shared_from 推断'],
    result_kind: 'parsed',
    deterministic: true,
  },
  analyze_sample_series: {
    name: 'analyze_sample_series',
    input_type: 'record_ref（同一论文的样品系列）',
    output_type: 'StudyContrast',
    preconditions: ['至少两个含目标相的样品', '可读取制备条件'],
    scientific_scope: '比较同一论文内样品之间主动改变的变量、保持条件与未报告项；不估计因果效应',
    unsupported_cases: ['跨论文合并', '从曲线图读数值', '把空字段当作控制变量一致'],
    result_kind: 'derived_analysis',
    deterministic: true,
  },
  check_evidence_continuity: {
    name: 'check_evidence_continuity',
    input_type: 'record_ref + 已登记的观察与样品关系',
    output_type: 'ContinuityReport',
    preconditions: ['研究库中已有该论文的观察或关系'],
    scientific_scope: '比较样品 ID 与目标相化学指纹，判断旧证据是否仍对应当前修订的实验样品',
    unsupported_cases: ['指纹只覆盖目标相与金属集合，不判断晶型、占位或纯度', '旧行没有指纹时只能报告 unverifiable', '两个样品化学指纹相同时不自动绑定'],
    result_kind: 'derived_analysis',
    deterministic: true,
  },
  explain_claim_disagreement: {
    name: 'explain_claim_disagreement',
    input_type: 'ScientificClaim 集合',
    output_type: 'ClaimGraph（分歧解释）',
    preconditions: ['论断已登记 topic、kind、stance 与范围'],
    scientific_scope: '先对齐主体、状态和范围，再判断是否真冲突；区分引用与独立支持',
    unsupported_cases: ['没有登记 topic 的论断无法配对', '缺少范围信息时只能报告未对齐'],
    result_kind: 'derived_analysis',
    deterministic: true,
  },
  develop_competing_hypotheses: {
    name: 'develop_competing_hypotheses',
    input_type: '观察 + 已有解释 + 缺口',
    output_type: 'HypothesisSet',
    preconditions: ['有明确观察对象'],
    scientific_scope: '生成少量实质不同的解释及其可反驳条件',
    unsupported_cases: ['没有观察对象时不得凭空生成', '不能把系统假设写入原文事实表'],
    result_kind: 'model_hypothesis',
    deterministic: false,
  },
  identify_discriminating_observations: {
    name: 'identify_discriminating_observations',
    input_type: 'HypothesisSet',
    output_type: 'HypothesisSet（区分性观察）',
    preconditions: ['每条假设至少有一个可反驳条件'],
    scientific_scope: '找出两种解释预期不同的观察；找不到时明确说现有信息不能区分',
    unsupported_cases: ['没有预测或不可证伪的假设不参与区分'],
    result_kind: 'derived_analysis',
    deterministic: true,
  },
  resolve_structure_candidate: {
    name: 'resolve_structure_candidate',
    input_type: 'CIF/POSCAR 路径或结构来源',
    output_type: 'StructureArtifact',
    preconditions: ['文件可读且格式受支持'],
    scientific_scope: '解析晶胞、位点与组成并检查输入问题；不判断结构是否物理合理',
    unsupported_cases: ['只有化学式时不能编造晶格与坐标', '无序占位与变量组成需要显式选择'],
    result_kind: 'parsed',
    deterministic: true,
  },
  prepare_computation_spec: {
    name: 'prepare_computation_spec',
    input_type: 'ComputationIntent + StructureArtifact',
    output_type: 'ComputationSpec',
    preconditions: ['问题、可观测量与至少一个候选结构'],
    scientific_scope: '组织可交接的计算任务，列出未定参数与预期输出',
    unsupported_cases: ['不执行 DFT', '不把未指定参数悄悄固定为默认值', '不把结构文件称为计算结论'],
    result_kind: 'parsed',
    deterministic: true,
  },
};

export interface PlanNode {
  step: string;
  capability: string;
  input_type: string;
  output_type: string;
  deterministic: boolean;
  blocked_by: string[];
}

export interface TaskPlan {
  task: ResearchTask;
  ready: boolean;
  nodes: PlanNode[];
  unresolved_inputs: string[];
  required_facets: FacetName[];
  model_steps: { step: string; capability: string; contract: string }[];
  notes: string[];
}

const TASK_FACETS: Record<TaskType, FacetName[]> = {
  material_identity: ['material_identity'],
  material_relation: ['material_identity'],
  specimen_lineage: ['material_identity', 'structures'],
  series_analysis: ['study_design', 'observations'],
  claim_disagreement: ['claims', 'observations'],
  hypothesis_analysis: ['observations', 'claims'],
  computation_preparation: ['material_identity', 'structures'],
};

const TASK_STEPS: Record<TaskType, string[]> = {
  material_identity: ['resolve_material_identity'],
  material_relation: ['resolve_material_identity', 'relate_material_entities'],
  specimen_lineage: ['resolve_material_identity', 'build_specimen_lineage'],
  series_analysis: ['resolve_material_identity', 'build_specimen_lineage', 'analyze_sample_series'],
  claim_disagreement: ['explain_claim_disagreement'],
  hypothesis_analysis: ['identify_discriminating_observations'],
  computation_preparation: ['resolve_material_identity', 'resolve_structure_candidate', 'prepare_computation_spec'],
};

/**
 * Compile a question into an explicit plan. A missing input is reported, never filled in
 * by inventing a sample, an observation or a structure.
 */
export function planResearchTask(task: ResearchTask): TaskPlan {
  if (!TASK_TYPES.includes(task.task_type)) throw new Error(`未知任务类型：${task.task_type}`);
  if (!task.question || !task.question.trim()) throw new Error('研究任务需要 question');
  const refs = (task.subject_refs ?? []).map(normalizeSubjectRef);
  const unresolved: string[] = [];
  if (!refs.length) unresolved.push('subject_refs：尚未定位材料、样品、文献或结构');
  if (task.task_type === 'computation_preparation' && !refs.some(ref => ref.structure_id)) unresolved.push('structures：尚未提供结构文件或结构来源');
  if (task.task_type === 'claim_disagreement' && !refs.some(ref => ref.claim_id)) unresolved.push('claims：尚未登记要比较的科学论断');
  if (task.task_type === 'hypothesis_analysis' && !refs.some(ref => ref.hypothesis_id)) unresolved.push('hypotheses：尚未提供竞争假设');

  const nodes: PlanNode[] = TASK_STEPS[task.task_type].map(step => {
    const contract = CAPABILITIES[step];
    if (!contract) throw new Error(`缺少能力合同：${step}`);
    return {
      step, capability: step, input_type: contract.input_type, output_type: contract.output_type,
      deterministic: contract.deterministic, blocked_by: [],
    };
  });
  const modelSteps = task.task_type === 'hypothesis_analysis'
    ? [{ step: 'develop_competing_hypotheses', capability: 'develop_competing_hypotheses', contract: '输入观察与已有解释，输出少量可反驳假设；不得进入原文事实表' }]
    : task.task_type === 'series_analysis'
      ? [{ step: 'load_facet:observations', capability: 'facet', contract: '若库内没有结果变量，只能完成设计分析，不能判断效应' }]
      : task.task_type === 'claim_disagreement'
        ? [{ step: 'load_facet:claims', capability: 'facet', contract: '论断需带 topic、kind、stance 与范围；未登记时不能代替作者原话' }]
        : [];

  return {
    task: { ...task, subject_refs: refs, required_facets: task.required_facets ?? TASK_FACETS[task.task_type] },
    ready: unresolved.length === 0,
    nodes, unresolved_inputs: unresolved,
    required_facets: task.required_facets ?? TASK_FACETS[task.task_type],
    model_steps: modelSteps,
    notes: [
      '计划节点表达依赖关系，不重写批处理队列，也不表示制备步骤顺序。',
      '确定性节点可以直接执行；模型步骤的输出必须带 provenance=model_hypothesis 或 model_interpretation。',
      '输入未满足时输出未满足项，不让后续节点凭空补一个样品、观察或结构。',
    ],
  };
}
