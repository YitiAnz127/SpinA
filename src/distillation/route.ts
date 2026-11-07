import { Type } from 'typebox';
import { ExperimentStore, type RecordReference } from './store.ts';
import { preparationChain } from './preparation.ts';
import { preparationVariables, deriveMetalElements, type Draft, type Fact } from './schema.ts';
import { quantityOf, textContains } from './conditions.ts';
import { lowerBound, parseQuantity, programHoldSeconds, upperBound, type NumericValue, type Quantity } from './numeric.ts';
import { stepSynonyms } from './synonyms.ts';

/**
 * Route-level condition constraints.
 *
 * A single step matching a temperature does not mean the whole route satisfies it. This module
 * aggregates every step of the selected sample and its explicit shared ancestors, keeps
 * unknown values unknown, and reports satisfied / violated / undetermined per constraint.
 */

const operationList = Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 8 });
export const RouteConstraintQuerySchema = Type.Object({
  metal_elements: Type.Optional(Type.Array(Type.String({ pattern: '^[A-Z][a-z]?$' }), { minItems: 1, maxItems: 12 })),
  match: Type.Optional(Type.Union([Type.Literal('exact'), Type.Literal('superset')])),
  include_uncertain: Type.Optional(Type.Boolean({ default: true, description: '默认 true：包含历史待核对版本及可能匹配。' })),
  max_temperature: Type.Optional(Type.Number({ description: '整条路线的最高温度上限（°C）。' })),
  max_total_duration_hours: Type.Optional(Type.Number({ minimum: 0, description: '整条路线的总时长上限（小时）。' })),
  required_operations: Type.Optional(operationList),
  forbidden_operations: Type.Optional(operationList),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
}, {
  additionalProperties: false,
  anyOf: [{ required: ['max_temperature'] }, { required: ['max_total_duration_hours'] }, { required: ['required_operations'] }, { required: ['forbidden_operations'] }],
});

export interface RouteConstraintQuery {
  metal_elements?: string[];
  match?: 'exact' | 'superset';
  include_uncertain?: boolean;
  max_temperature?: number;
  max_total_duration_hours?: number;
  required_operations?: string[];
  forbidden_operations?: string[];
  limit?: number;
  offset?: number;
}

export interface RouteStep {
  source_sample_id: string;
  step_id: string;
  operation: string;
  text: string;
  temperatures: { raw: string; value: NumericValue | null }[];
  durations: { raw: string; value: NumericValue | null }[];
}

export interface ConstraintResult {
  status: 'satisfied' | 'violated' | 'undetermined';
  limit: number | null;
  value: number | null;
  upper_bound: number | null;
  unknown_steps: string[];
  detail: string;
}

export interface OperationResult {
  term: string;
  status: 'satisfied' | 'violated' | 'undetermined';
  matched_steps: string[];
  detail: string;
}

export interface RouteAssessment {
  paper: { paper_id: string; doi: string; title: string };
  record_ref: RecordReference;
  sample_id: string;
  possible?: boolean;
  sample: string;
  route: {
    step_count: number;
    steps: { source_sample_id: string; step_id: string; operation: string; temperature: string | null; duration: string | null; origin: 'own' | 'inherited' }[];
    unbound_conditions: { sample_id: string; name: string; quantity: Quantity; raw: string }[];
    /** What the record does and does not say about how steps combine. */
    structure: {
      ordering_basis: 'record_order';
      parallelism_known: false;
      replacement_known: false;
      /** shared_from chain, root first; empty when the sample has no shared procedure. */
      inheritance: { sample_id: string; shared_from: string | null }[];
      /** Steps that came from a shared ancestor rather than this sample's own record. */
      inherited_step_count: number;
      warnings: string[];
    };
  };
  max_temperature: ConstraintResult | null;
  total_duration: ConstraintResult | null;
  operations: { required: OperationResult[]; forbidden: OperationResult[] };
  overall: 'satisfied' | 'violated' | 'undetermined';
  reasons: string[];
  assumptions: string[];
}

const factText = (fact: Fact): string => {
  if (typeof fact.raw === 'string' && fact.raw.trim()) return fact.raw.trim();
  if (typeof fact.value === 'string') return fact.value;
  if (fact.value !== null) return String(fact.value);
  return '';
};

const ASSUMPTIONS = [
  '步骤按记录顺序视为顺序执行；共用祖先步骤排在子样品之前。记录没有并行或替换标记，本工具不推断这些关系。',
  '没有温度条件的步骤按未知处理；显式未报告或无法解析的温度使最高温度不确定。',
  '总时长要求每一步都有可解析时长；缺少时长时只给出已知下界，不给估计值。',
  '范围取上界用于“最高温度”，取下界/上界分别用于“总时长”的判定；不使用区间中点。',
];

function buildRoute(record: { draft: Draft }, chain: Draft['samples']): { steps: RouteStep[]; unbound: RouteAssessment['route']['unbound_conditions'] } {
  const steps: RouteStep[] = [];
  const unbound: RouteAssessment['route']['unbound_conditions'] = [];
  for (const sample of chain) {
    for (const step of sample.steps) {
      const temperatures = step.conditions.filter(condition => quantityOf(condition.name) === 'temperature')
        .map(condition => ({ raw: factText(condition.fact), value: parseQuantity(condition.fact, 'temperature') }));
      const durations = step.conditions.filter(condition => quantityOf(condition.name) === 'duration')
        .map(condition => ({ raw: factText(condition.fact), value: parseQuantity(condition.fact, 'duration') }));
      steps.push({
        source_sample_id: sample.local_id, step_id: step.local_id,
        operation: factText(step.operation),
        text: [step.operation.raw, step.description.raw].filter(Boolean).join(' '),
        temperatures, durations,
      });
    }
    for (const variable of preparationVariables(sample)) {
      const quantity = quantityOf(variable.name) as Quantity | null;
      if (!quantity) continue;
      // A shared quantity name alone cannot bind a variable to one step.

      unbound.push({ sample_id: sample.local_id, name: variable.name, quantity, raw: factText(variable.fact) });
    }
  }
  return { steps, unbound };
}

/**
 * Route structure is deliberately conservative: the record has no parallel/replacement markers,
 * so the tool reports the ordering basis and the inheritance chain instead of guessing a graph.
 */
function routeStructure(chain: Draft['samples'], sampleId: string, steps: RouteStep[]): RouteAssessment['route']['structure'] {
  const inherited = steps.filter(step => step.source_sample_id !== sampleId);
  const warnings: string[] = ['记录未标注并行或替换关系；路线按记录顺序聚合，不代表已验证的工序顺序'];
  if (inherited.length) warnings.push(`其中 ${inherited.length} 个步骤来自共用流程，需核对是否适用于本样品的实际分支`);
  if (chain.length > 1) warnings.push('共用祖先的步骤排在子样品自身步骤之前；同一祖先下不同分支的步骤不互相继承');
  return {
    ordering_basis: 'record_order', parallelism_known: false, replacement_known: false,
    inheritance: chain.map(sample => ({ sample_id: sample.local_id, shared_from: sample.shared_from })),
    inherited_step_count: inherited.length, warnings,
  };
}

function assessMaxTemperature(steps: RouteStep[], limit: number): ConstraintResult {
  let minimum: number | null = null, maximum: number | null = null;
  const unknown: string[] = [];
  for (const step of steps) {
    if (!step.temperatures.length) unknown.push(step.step_id);
    for (const { value } of step.temperatures) {
      const high = upperBound(value);
      const low = value?.kind === 'program' ? high : lowerBound(value);
      if (low !== null) minimum = Math.max(minimum ?? low, low);
      if (high !== null) maximum = Math.max(maximum ?? high, high);
      if (low !== null && (low > limit || (low === limit && value?.exclusive && value.kind === 'lower'))) {
        return { status: 'violated', limit, value: low, upper_bound: null, unknown_steps: unknown,
          detail: `步骤 ${step.step_id} 超过温度上限 ${limit} °C（${value?.raw}）` };
      }
      if (high === null || high > limit) unknown.push(step.step_id);
    }
  }
  if (unknown.length || maximum === null) return { status: 'undetermined', limit, value: minimum, upper_bound: null,
    unknown_steps: [...new Set(unknown)], detail: '步骤温度缺失、仅为近似值或允许的范围跨越上限，无法确定整条路线满足条件' };
  return { status: 'satisfied', limit, value: maximum, upper_bound: maximum, unknown_steps: [],
    detail: `记录给出的路线温度上界为 ${maximum} °C，不超过 ${limit} °C` };
}

function assessTotalDuration(steps: RouteStep[], limitSeconds: number): ConstraintResult {
  let strictMinimum = false;
  let minSum = 0, maxSum: number | null = steps.length ? 0 : null;
  const unknown: string[] = [];
  for (const step of steps) {
    if (step.durations.length !== 1) { unknown.push(step.step_id); maxSum = null; continue; }
    let stepMin = 0, stepMax: number | null = 0;
    for (const item of step.durations) {
      const value = item.value;
      if (!value || value.kind === 'unparsed') { stepMax = null; continue; }
      const hold = programHoldSeconds(value);
      const low = hold ?? lowerBound(value) ?? 0;
      const high = hold ?? upperBound(value);
      strictMinimum ||= value.kind === 'lower' && !!value.exclusive;
      stepMin += low;
      if (high === null) stepMax = null;
      else if (stepMax !== null) stepMax += high;
    }
    minSum += stepMin;
    if (stepMax === null) maxSum = null;
    else if (maxSum !== null) maxSum += stepMax;
    if (stepMax === null) unknown.push(step.step_id);
  }
  if (minSum > limitSeconds || (strictMinimum && minSum === limitSeconds)) {
    return { status: 'violated', limit: limitSeconds, value: minSum, upper_bound: maxSum, unknown_steps: unknown,
      detail: `已知总时长至少 ${(minSum / 3600).toFixed(2)} h，已超过上限 ${(limitSeconds / 3600).toFixed(2)} h` };
  }
  if (maxSum !== null && maxSum <= limitSeconds) {
    return { status: 'satisfied', limit: limitSeconds, value: minSum, upper_bound: maxSum, unknown_steps: [],
      detail: `所有步骤时长已知，总计 ${(maxSum / 3600).toFixed(2)} h，不超过 ${(limitSeconds / 3600).toFixed(2)} h` };
  }
  return { status: 'undetermined', limit: limitSeconds, value: minSum, upper_bound: maxSum, unknown_steps: unknown,
    detail: `已知总时长至少 ${(minSum / 3600).toFixed(2)} h${maxSum === null ? '' : `，至多 ${(maxSum / 3600).toFixed(2)} h`}；仍有 ${unknown.length} 个步骤缺少可解析时长，不能判定整条路线在 ${(limitSeconds / 3600).toFixed(2)} h 内完成` };
}

function assessOperations(steps: RouteStep[], required: string[], forbidden: string[]) {
  const match = (term: string) => {
    const aliases = stepSynonyms(term);
    return steps.filter(step => aliases.some(alias => textContains(step.text, alias))).map(step => step.step_id);
  };
  return {
    required: required.map(term => {
      const matched = match(term);
      return matched.length
        ? { term, status: 'satisfied' as const, matched_steps: matched, detail: `在步骤 ${matched.join('、')} 中找到「${term}」或其受控同义词` }
        : { term, status: 'undetermined' as const, matched_steps: [], detail: `库内未记录「${term}」；这不能证明实际未使用该操作` };
    }),
    forbidden: forbidden.map(term => {
      const matched = match(term);
      return matched.length
        ? { term, status: 'violated' as const, matched_steps: matched, detail: `步骤 ${matched.join('、')} 含被排除的操作「${term}」` }
        : { term, status: 'undetermined' as const, matched_steps: [], detail: `记录未列出「${term}」` };
    }),
  };
}

export function assessRoute(record: {
  paper: { paper_id: string; doi: string; title: string }; draft: Draft; revision: number; verified_at: string;
}, version: RecordReference['version'], sample: Draft['samples'][number], query: RouteConstraintQuery): RouteAssessment {
  const chain = preparationChain(record.draft, sample.local_id);
  const { steps, unbound } = buildRoute(record, chain);
  let maxTemperature = query.max_temperature === undefined ? null : assessMaxTemperature(steps, query.max_temperature);
  let totalDuration = query.max_total_duration_hours === undefined ? null : assessTotalDuration(steps, query.max_total_duration_hours * 3600);
  const operations = assessOperations(steps, query.required_operations ?? [], query.forbidden_operations ?? []);
  // shared_from describes a shared procedure, not necessarily a sequence of additive steps.
  const own = steps.filter(step => step.source_sample_id === sample.local_id);
  const inherited = own.length !== steps.length;
  const structure = routeStructure(chain, sample.local_id, steps);
  function restrict(result: ConstraintResult | null, quantity: Quantity, local: () => ConstraintResult) {
    if (!result || (!inherited && !unbound.some(item => item.quantity === quantity))) return result;
    const localResult = local();
    if (localResult.status === 'violated' && !unbound.some(item => item.quantity === quantity)) return localResult;
    return { ...result, status: 'undetermined' as const, value: null, upper_bound: null,
      detail: '共用流程适用范围或样品级变量尚未绑定，无法确认整条路线' };
  }
  maxTemperature = restrict(maxTemperature, 'temperature', () => assessMaxTemperature(own, query.max_temperature!));
  totalDuration = restrict(totalDuration, 'duration', () => assessTotalDuration(own, query.max_total_duration_hours! * 3600));
  if (inherited) {
    const local = assessOperations(own, query.required_operations ?? [], query.forbidden_operations ?? []);
    for (const [i, result] of operations.required.entries()) if (!local.required[i].matched_steps.length) Object.assign(result, local.required[i]);
    for (const [i, result] of operations.forbidden.entries()) if (!local.forbidden[i].matched_steps.length) Object.assign(result, local.forbidden[i]);
  }
  const statuses = [
    ...(maxTemperature ? [maxTemperature.status] : []),
    ...(totalDuration ? [totalDuration.status] : []),
    ...operations.required.map(item => item.status),
    ...operations.forbidden.map(item => item.status),
  ];
  const overall: RouteAssessment['overall'] = statuses.includes('violated') ? 'violated'
    : statuses.includes('undetermined') ? 'undetermined' : 'satisfied';
  const reasons = [
    ...(maxTemperature ? [maxTemperature.detail] : []),
    ...(totalDuration ? [totalDuration.detail] : []),
    ...operations.required.filter(item => item.status !== 'satisfied').map(item => item.detail),
    ...operations.forbidden.map(item => item.detail),
  ];
  if (unbound.length) reasons.push(`样品级变量 ${unbound.map(item => item.name).join('、')} 未绑定到步骤，未计入路线聚合`);
  return {
    paper: record.paper, record_ref: { paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at },
    sample_id: sample.local_id, sample: sample.name,
    route: {
      step_count: steps.length,
      steps: steps.map(step => ({
        source_sample_id: step.source_sample_id, step_id: step.step_id, operation: step.operation,
        temperature: step.temperatures.map(item => item.raw).filter(Boolean).join('；') || null,
        duration: step.durations.map(item => item.raw).filter(Boolean).join('；') || null,
        origin: step.source_sample_id === sample.local_id ? 'own' as const : 'inherited' as const,
      })),
      structure,
      unbound_conditions: unbound,
    },
    max_temperature: maxTemperature, total_duration: totalDuration, operations,
    overall, reasons, assumptions: ASSUMPTIONS,
  };
}

export async function searchRouteConstraints(root: string, query: RouteConstraintQuery, signal?: AbortSignal) {
  const store = await ExperimentStore.openExisting(root);
  try { return searchRouteConstraintsWith(store, query, signal); }
  finally { store?.close(); }
}

/** Same filter against an already-open (possibly read-only) store. */
export function searchRouteConstraintsWith(store: ExperimentStore | null, query: RouteConstraintQuery, signal?: AbortSignal) {
  const { limit = 20, offset = 0, include_uncertain = true } = query;
  if (query.max_temperature === undefined && query.max_total_duration_hours === undefined && !query.required_operations?.length && !query.forbidden_operations?.length) {
    throw new Error('路线约束至少需要最高温度、总时长、必需操作或排除操作之一');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('分页参数无效');
  if (query.max_temperature !== undefined && (!Number.isFinite(query.max_temperature) || query.max_temperature < -273.15)) throw new Error('max_temperature 无效');
  if (query.max_total_duration_hours !== undefined && (!Number.isFinite(query.max_total_duration_hours) || query.max_total_duration_hours < 0)) throw new Error('max_total_duration_hours 无效');
  for (const list of [query.required_operations, query.forbidden_operations]) {
    if (list?.some(term => !term.trim())) throw new Error('操作名称不能为空');
  }
  const metals = [...new Set(query.metal_elements ?? [])].sort();
  if (query.metal_elements && (!metals.length || metals.some(element => deriveMetalElements(element)?.join('|') !== element))) throw new Error('请提供有效金属集合');
  if (query.match && !['exact', 'superset'].includes(query.match)) throw new Error('金属匹配方式无效');

  const stored = store?.readPublishedVersions(include_uncertain) ?? { records: [], warnings: [] };
  const results: RouteAssessment[] = [];
  let scanned = 0;
  for (const { record, version } of stored.records) {
    const start = results.length;
    try {
      for (const sample of record.draft.samples) {
        signal?.throwIfAborted();
        if (!sample.phases.some(phase => phase.role === 'target_spinel')) continue;
        const entries = [...record.match_entries, ...(include_uncertain ? record.candidate_match_entries ?? [] : [])]
          .filter(entry => entry.sample_local_id === sample.local_id);
        const eligible = metals.length
          ? entries.filter(entry => query.match === 'superset'
            ? entry.metal_elements.length > metals.length && metals.every(element => entry.metal_elements.includes(element))
            : entry.element_key === metals.join('|'))
          : entries;
        if (metals.length && !eligible.length || !include_uncertain && !record.match_entries.some(entry => eligible.includes(entry))) continue;
        scanned++;
        const assessment = assessRoute(record, version, sample, query);
        if (metals.length) {
          assessment.possible = !eligible.some(entry => record.match_entries.includes(entry));
          if (assessment.possible) {
            if (assessment.overall === 'satisfied') assessment.overall = 'undetermined';
            assessment.reasons.push('所选金属集合仅为可能匹配');
          }
        }
        results.push(assessment);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      results.length = start;
      stored.warnings.push({ paper_id: record.paper.paper_id, version, message: '记录或共用流程无法解析，已跳过；筛选范围不完整' });
    }
  }

  const rank = { satisfied: 0, undetermined: 1, violated: 2 } as const;
  results.sort((a, b) => rank[a.overall] - rank[b.overall] || a.paper.paper_id.localeCompare(b.paper.paper_id) ||
    a.record_ref.version.localeCompare(b.record_ref.version) || a.sample_id.localeCompare(b.sample_id));
  const page = results.slice(offset, offset + limit), next = offset + page.length;
  return {
    query,
    semantics: '按样品及其显式共用祖先聚合整条路线；范围取上界判定最高温度，总时长缺少步骤时只给下界；满足/不满足/无法判断三态，不把单步命中升级为整条路线满足。route.structure 说明步骤如何组合：记录没有并行/替换标记时按记录顺序聚合，并给出继承链与继承步骤数。',
    assumptions: ASSUMPTIONS,
    total: results.length,
    satisfied: results.filter(result => result.overall === 'satisfied').length,
    undetermined: results.filter(result => result.overall === 'undetermined').length,
    violated: results.filter(result => result.overall === 'violated').length,
    scanned_samples: scanned,
    offset, limit, has_more: next < results.length, next_offset: next < results.length ? next : null,
    results: page,
    ...(stored.warnings.length ? { warnings: stored.warnings } : {}),
  };
}
