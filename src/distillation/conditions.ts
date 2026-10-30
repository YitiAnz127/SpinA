import { ExperimentStore, type RecordReference } from './store.ts';
import { deriveMetalElements, preparationVariables, type Fact } from './schema.ts';
import { preparationChain } from './preparation.ts';
import { isExtractionIssue, missingInformation, sourceLimitations } from './missing-information.ts';
import { Type } from 'typebox';

const bounds = {
  min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()),
  min_inclusive: Type.Optional(Type.Boolean()), max_inclusive: Type.Optional(Type.Boolean()),
};
const numericBounds = { additionalProperties: false, anyOf: [{ required: ['min'] }, { required: ['max'] }] };
export const PreparationConditionQuerySchema = Type.Object({
  metal_elements: Type.Optional(Type.Array(Type.String({ pattern: '^[A-Z][a-z]?$' }), { minItems: 1, maxItems: 12 })),
  match: Type.Optional(Type.Union([Type.Literal('exact'), Type.Literal('superset')])),
  include_uncertain: Type.Optional(Type.Boolean({ default: true, description: '默认 true：包含历史待核对版本及可能匹配；false 同时排除这两类。' })),
  step_terms: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
    minItems: 1, maxItems: 12, description: '附加步骤过滤，必须与温度、时长或原料条件同时使用。',
  })),
  temperature: Type.Optional(Type.Object(bounds, numericBounds)),
  duration: Type.Optional(Type.Object({ ...bounds,
    min: Type.Optional(Type.Number({ minimum: 0 })), max: Type.Optional(Type.Number({ minimum: 0 })),
    unit: Type.Optional(Type.Union((['s', 'min', 'h', 'd'] as const).map(unit => Type.Literal(unit)))),
  }, numericBounds)),
  materials: Type.Optional(Type.Array(Type.Object({ terms: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 12 }),
    mode: Type.Union([Type.Literal('listed'), Type.Literal('not_listed')]),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 8 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
}, { additionalProperties: false, anyOf: [{ required: ['temperature'] }, { required: ['duration'] }, { required: ['materials'] }] });

export interface Bounds { min?: number; max?: number; min_inclusive?: boolean; max_inclusive?: boolean }
export interface ConditionQuery {
  metal_elements?: string[]; match?: 'exact' | 'superset'; include_uncertain?: boolean;
  step_terms?: string[]; temperature?: Bounds; duration?: Bounds & { unit?: 's' | 'min' | 'h' | 'd' };
  materials?: { terms: string[]; mode: 'listed' | 'not_listed' }[];
  limit?: number; offset?: number;
}
type Quantity = 'temperature' | 'duration';
type State = 'field_match' | 'needs_review' | 'no';
const seconds = { s: 1, min: 60, h: 3600, d: 86400 };
const normalize = (text: string) => text.normalize('NFKC').replace(/[−–—]/g, '-').replace(/\s+/g, ' ').trim();
function contains(text: string, term: string) {
  const needle = normalize(term).toLowerCase();
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /[a-z0-9]/i.test(needle)
    ? new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(normalize(text))
    : normalize(text).includes(needle);
}
const quantityOf = (name: string): Quantity | null => /rate|speed|速率|速度/i.test(name) ? null
  : /duration|(?:^|_)time(?:_|$)|时间|时长/i.test(name) ? 'duration'
  : /temperature|(?:^|_)temp(?:_|$)|温度/i.test(name) ? 'temperature' : null;

function unitValue(number: number, unit: string, quantity: Quantity): number | null {
  const value = normalize(unit).toLowerCase().replace(/\s+/g, '');
  if (quantity === 'temperature') {
    if (['°c', 'oc', 'ºc', '◦c', 'cº', 'c', '摄氏度', 'celsius'].includes(value)) return number;
    if (['k', 'kelvin'].includes(value)) return number - 273.15;
    if (['°f', 'f', 'fahrenheit'].includes(value)) return (number - 32) * 5 / 9;
  } else {
    if (/^(?:s|sec|secs|second|seconds|秒)$/.test(value)) return number;
    if (/^(?:min|mins|minute|minutes|分钟|分)$/.test(value)) return number * 60;
    if (/^(?:h|hr|hrs|hour|hours|小时)$/.test(value)) return number * 3600;
    if (/^(?:d|day|days|天)$/.test(value)) return number * 86400;
  }
  return null;
}

/** Single explicitly dimensioned values only. Ranges/programmes remain for source-grounded review. */
export function conditionNumber(fact: Fact, quantity: Quantity): { value: number; inferred: boolean } | null {
  if (fact.status !== 'reported') return null;
  const parse = (value: unknown) => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([^\d]*)$/.exec(normalize(String(value)).replace(/^(?:at|for)\s+/i, ''));
    if (!match) return null;
    const number = Number(match[1]), embedded = match[2].trim();
    const result = unitValue(number, embedded || fact.unit || '', quantity);
    if (result === null || !Number.isFinite(result)) return null;
    const separate = fact.unit ? unitValue(number, fact.unit, quantity) : result;
    if (separate === null || Math.abs(separate - result) > 1e-8) return null;
    return result;
  };
  const raw = parse(fact.raw);
  if (raw !== null) return { value: raw, inferred: false };
  const value = parse(fact.value);
  return value === null ? null : { value, inferred: true };
}

function accepts(value: number, bounds: Bounds, scale: number) {
  const compare = (bound: number) => Math.abs(value - bound) < 1e-8 ? 0 : Math.sign(value - bound);
  return (bounds.min === undefined || (bounds.min_inclusive === false ? compare(bounds.min * scale) > 0 : compare(bounds.min * scale) >= 0)) &&
    (bounds.max === undefined || (bounds.max_inclusive === false ? compare(bounds.max * scale) < 0 : compare(bounds.max * scale) <= 0));
}

export async function searchPreparationConditions(root: string, query: ConditionQuery, signal?: AbortSignal) {
  const { limit = 20, offset = 0, include_uncertain = true } = query;
  const quantities = (['temperature', 'duration'] as const).filter(key => query[key]);
  const hasStepFilter = quantities.length > 0 || Boolean(query.step_terms?.length);
  if (!quantities.length && !query.materials?.length) throw new Error('请提供温度、时长或原料筛选条件（step_terms 需与其中之一同时使用）');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('分页参数无效');
  for (const key of quantities) {
    const bounds = query[key]!;
    if ((bounds.min === undefined && bounds.max === undefined) || [bounds.min, bounds.max].some(value => value !== undefined && !Number.isFinite(value)) ||
      (bounds.min !== undefined && bounds.max !== undefined && (bounds.min > bounds.max || bounds.min === bounds.max && (bounds.min_inclusive === false || bounds.max_inclusive === false)))) throw new Error('数值筛选范围无效');
  }
  if (query.duration?.unit && !(query.duration.unit in seconds)) throw new Error('时长单位无效');
  if (query.step_terms?.some(term => !term.trim()) || query.materials?.some(filter => !filter.terms.length || filter.terms.some(term => !term.trim()) || !['listed', 'not_listed'].includes(filter.mode))) throw new Error('关键词不能为空');
  const metals = [...new Set(query.metal_elements ?? [])].sort();
  if (query.metal_elements && (!metals.length || metals.some(element => deriveMetalElements(element)?.join('|') !== element))) throw new Error('请提供有效金属集合');
  if (query.match && !['exact', 'superset'].includes(query.match)) throw new Error('金属匹配方式无效');
  const store = await ExperimentStore.openExisting(root);
  const stored = store?.readPublishedVersions(include_uncertain) ?? { records: [], warnings: [] };
  store?.close();
  const results: {
    paper: typeof stored.records[number]['record']['paper']; record_ref: RecordReference; sample_id: string; sample: string;
    possible: boolean; match_status: Exclude<State, 'no'>; review_required: true;
    material_checks: { terms: string[]; mode: string; listed: boolean; evidence: { source_sample_id: string; field_path: string; fact: Fact }[] }[];
    step_matches: { source_sample_id: string; step_id: string | null; operation: string | null; state: Exclude<State, 'no'>;
      checks: { quantity: Quantity; field_path: string; fact: Fact; normalized_value: number | null; normalized_unit: string }[] }[];
    reasons: string[];
  }[] = [];
  let unevaluable = 0, scanned = 0;
  for (const { record, version } of stored.records) {
    const start = results.length;
    try {
      for (const target of record.draft.samples) {
        signal?.throwIfAborted();
        if (!target.phases.some(phase => phase.role === 'target_spinel')) continue;
        const entries = [...record.match_entries, ...(include_uncertain ? record.candidate_match_entries ?? [] : [])].filter(entry => entry.sample_local_id === target.local_id);
        const eligible = metals.length ? entries.filter(entry => (query.match === 'superset' ? entry.metal_elements.length > metals.length && metals.every(element => entry.metal_elements.includes(element)) : entry.element_key === metals.join('|'))) : entries;
        if (metals.length && !eligible.length || !include_uncertain && !record.match_entries.some(entry => eligible.includes(entry))) continue;
        scanned++;
        const chain = preparationChain(record.draft, target.local_id, signal), scope = new Set(chain.map(sample => sample.local_id));
        const reasons: string[] = [];
        const materials = chain.flatMap(sample => sample.materials.map(material => ({ source_sample_id: sample.local_id, field_path: `samples.${sample.local_id}.materials.${material.local_id}.identity`, fact: material.identity })));
        const materialChecks = (query.materials ?? []).map(filter => ({ ...filter,
          listed: materials.some(material => filter.terms.some(term => contains(String(material.fact.raw ?? material.fact.value ?? ''), term))),
          evidence: materials.filter(material => filter.terms.some(term => contains(String(material.fact.raw ?? material.fact.value ?? ''), term))),
        }));
        if (materialChecks.some(check => check.mode === 'listed' && !check.listed || check.mode === 'not_listed' && check.listed)) continue;
        if (materialChecks.some(check => check.mode === 'not_listed')) reasons.push('原料条件只表示库内未列出，不证明实际未使用');
        if (materialChecks.some(check => check.evidence.some(item => item.source_sample_id !== target.local_id || item.fact.status !== 'reported' || item.fact.note))) reasons.push('原料归属或状态需结合样品限定复核');
        const stepMatches: typeof results[number]['step_matches'] = [];
        let relevantStep = false;
        const candidates = chain.flatMap(sample => sample.steps.map(step => ({ owner: sample.local_id, step_id: step.local_id,
          operation: step.operation.raw, text: [step.local_id, step.operation.raw, step.description.raw].join(' '),
          limited: Boolean(step.operation.note || step.description.note),
          fields: step.conditions.map(condition => ({ name: condition.name, fact: condition.fact, field_path: `samples.${sample.local_id}.steps.${step.local_id}.conditions.${condition.name}` })),
        })));
        const variables = preparationVariables(target).filter(variable => quantityOf(variable.name));
        if (variables.length) candidates.push({ owner: target.local_id, step_id: '', operation: null, text: variables.map(variable => variable.name).join(' '), limited: true,
          fields: variables.map(variable => ({ ...variable, field_path: `samples.${target.local_id}.variables.${variable.name}` })) });
        if (hasStepFilter) for (const step of candidates) {
          if (query.step_terms?.length && !query.step_terms.some(term => contains(step.text, term))) continue;
          if (quantities.length ? !step.fields.some(field => quantities.includes(quantityOf(field.name)!)) : !step.step_id) continue;
          relevantStep = true;
          const checks: typeof stepMatches[number]['checks'] = [];
          let state: State = 'field_match';
          for (const quantity of quantities) {
            const fields = step.fields.filter(field => quantityOf(field.name) === quantity);
            if (!fields.length) { state = 'needs_review'; continue; }
            const values = fields.map(field => ({ ...field, numeric: conditionNumber(field.fact, quantity) }));
            const scale = quantity === 'duration' ? seconds[query.duration?.unit ?? 'h'] : 1;
            if (values.every(field => field.numeric && !accepts(field.numeric.value, query[quantity]!, scale))) { state = 'no'; break; }
            if (values.length !== 1 || values.some(field => !field.numeric || field.numeric.inferred || field.fact.note)) state = 'needs_review';
            checks.push(...values.map(field => ({ quantity, field_path: field.field_path, fact: field.fact,
              normalized_value: field.numeric?.value ?? null, normalized_unit: quantity === 'temperature' ? '°C' : 's' })));
          }
          if (state !== 'no') stepMatches.push({ source_sample_id: step.owner, step_id: step.step_id || null, operation: step.operation,
            state: step.owner !== target.local_id || step.limited ? 'needs_review' : state, checks });
        }
        if (hasStepFilter && !stepMatches.length) { if (!relevantStep) unevaluable++; continue; }
        const extractionIssues = record.verification.issues.filter(issue => isExtractionIssue(issue) && (issue.sample_local_id === null || scope.has(issue.sample_local_id)));
        if (extractionIssues.length || sourceLimitations(record, scope).length) reasons.push('记录存在相关抽取问题或来源限制，需读取对应说明');
        if (missingInformation(record, scope).length) reasons.push('流程有已记录缺项，不能将字段命中解释为完整配方');
        const definite = hasStepFilter ? stepMatches.some(step => step.state === 'field_match') : true;
        if (stepMatches.some(step => step.source_sample_id !== target.local_id)) reasons.push('含共用祖先字段，适用范围和子样品差异需复核');
        if (stepMatches.some(step => step.step_id === null)) reasons.push('含未绑定到具体步骤的样品变量，不能自动与步骤条件合并');
        const possible = !eligible.some(entry => record.match_entries.includes(entry));
        if (possible) reasons.push('目标相金属集合尚无确定匹配');
        results.push({ paper: record.paper, record_ref: { paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at },
          sample_id: target.local_id, sample: target.name, possible,
          match_status: definite && !reasons.length ? 'field_match' : 'needs_review', review_required: true,
          material_checks: materialChecks, step_matches: stepMatches, reasons });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      results.length = start;
      stored.warnings.push({ paper_id: record.paper.paper_id, version, message: '记录或共用流程无法解析，已跳过；筛选范围不完整' });
    }
  }
  results.sort((a, b) => Number(a.match_status === 'needs_review') - Number(b.match_status === 'needs_review') ||
    a.paper.paper_id.localeCompare(b.paper.paper_id) || a.record_ref.version.localeCompare(b.record_ref.version) || a.sample_id.localeCompare(b.sample_id));
  const page = results.slice(offset, offset + limit), next = offset + page.length;
  return { query, semantics: '同一步骤内的字段候选筛选；多个原料条件取AND，别名组内取OR。字段命中不代表整条配方满足；展开后核对适用范围。',
    total: results.length, field_matches: results.filter(result => result.match_status === 'field_match').length,
    needs_review: results.filter(result => result.match_status === 'needs_review').length, scanned_samples: scanned, unevaluable_samples: unevaluable,
    offset, limit, has_more: next < results.length, next_offset: next < results.length ? next : null, results: page,
    ...(stored.warnings.length ? { warnings: stored.warnings } : {}) };
}
