import { Type, type Static, type TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';

const strict = { additionalProperties: false };
const text = Type.String({ minLength: 1 });
const choice = <T extends string>(values: readonly T[]) => Type.Unsafe<T>(Type.Union(values.map(value => Type.Literal(value))));
const nullableText = Type.Union([text, Type.Null()]);

export const EvidenceSchema = Type.Object({
  source_id: text,
  page: Type.Integer({ minimum: 1 }),
  quote: Type.String({ minLength: 1, maxLength: 1600 }),
  location: Type.Optional(Type.String({ maxLength: 500 })),
  basis: Type.Optional(choice(['page_text', 'page_image'])),
}, strict);
export const FactSchema = Type.Object({
  raw: nullableText,
  value: Type.Union([text, Type.Number(), Type.Array(text), Type.Null()]),
  unit: nullableText,
  status: choice(['reported', 'derived', 'not_reported', 'source_missing', 'ambiguous', 'conflicting']),
  evidence: Type.Array(EvidenceSchema),
  note: Type.String(),
}, strict);
const namedFact = Type.Object({ name: text, fact: FactSchema }, strict);
export const PhaseSchema = Type.Object({
  local_id: text,
  role: choice(['target_spinel', 'support', 'additive', 'other', 'unknown']),
  formula: FactSchema,
  identity: FactSchema,
  purity: FactSchema,
  metal_elements: Type.Optional(FactSchema),
}, strict);
export const SampleSchema = Type.Object({
  local_id: text,
  name: text,
  aliases: Type.Array(text),
  material_state: choice(['as_prepared', 'post_treatment', 'post_reaction', 'intermediate', 'unspecified']),
  variables: Type.Array(namedFact),
  nominal_composition: FactSchema,
  measured_composition: FactSchema,
  phases: Type.Array(PhaseSchema),
  method: FactSchema,
  materials: Type.Array(Type.Object({
    local_id: text, identity: FactSchema, role: text,
    amount: FactSchema, concentration: FactSchema,
  }, strict)),
  steps: Type.Array(Type.Object({
    local_id: text, operation: FactSchema, description: FactSchema,
    material_refs: Type.Array(text),
    conditions: Type.Array(namedFact),
  }, strict)),
  shared_from: Type.Union([text, Type.Null()]),
  unresolved_questions: Type.Array(text),
}, strict);
export const DraftSchema = Type.Object({
  assessment: choice(['original_experiments', 'no_relevant_experiments', 'insufficient_sources', 'identity_mismatch']),
  samples: Type.Array(SampleSchema),
  notes: Type.Array(text),
}, strict);
export const VerificationSchema = Type.Object({
  source_identity: choice(['confirmed', 'mismatch', 'ambiguous']),
  coverage: choice(['complete', 'incomplete', 'undetermined']),
  issues: Type.Array(Type.Object({
    sample_local_id: Type.Union([text, Type.Null()]),
    field_path: text,
    issue_type: choice(['source_error', 'sample_mismatch', 'composition_or_phase_error', 'numeric_error',
      'unit_error', 'step_assignment_error', 'step_omission', 'unsupported_addition', 'omission', 'source_conflict']),
    current_value: Type.String(),
    source_evidence: Type.Array(EvidenceSchema),
    proposed_correction: Type.String(),
    resolution_status: choice(['confirmed_error', 'unresolved', 'resolved']),
    affects_matching: Type.Boolean(),
    action: Type.Optional(choice(['repair', 'source_limit'])),
  }, strict)),
  samples: Type.Array(Type.Object({
    sample_local_id: text,
    has_confirmed_errors: Type.Boolean(), has_unresolved_issues: Type.Boolean(),
    can_match: Type.Boolean(),
    expandable_fields: Type.Array(text), missing_or_uncertain: Type.Array(text),
  }, strict)),
  notes: Type.Array(text),
}, strict);
export type Evidence = Static<typeof EvidenceSchema>;
export type Fact = Static<typeof FactSchema>;
export type Draft = Static<typeof DraftSchema>;
export type Verification = Static<typeof VerificationSchema>;
export interface SourceDocument {
  id: string;
  path: string;
  kind: 'body' | 'si';
  pages: {
    number: number; text: string; image_path?: string;
    layout_text?: string; native_text?: string;
    extraction_method?: 'pdfjs' | 'pdfplumber' | 'pypdf' | 'tesseract';
    tables?: { bbox: number[]; rows: (string | null)[][] }[];
    warnings?: string[];
  }[];
}
export interface PaperIdentity { paper_id: string; doi: string; title: string }

// The model omits empty fields; the existing storage and validators still use full records.
const omittedFields = new Set(['aliases', 'variables', 'nominal_composition', 'measured_composition', 'purity',
  'formula', 'method', 'materials', 'steps', 'shared_from', 'unresolved_questions', 'notes', 'description',
  'amount', 'concentration', 'conditions', 'material_refs', 'checks', 'source_gaps', 'expandable_fields', 'missing_or_uncertain']);
const excludedFields = new Set(['aliases', 'nominal_composition', 'measured_composition', 'purity', 'description', 'expandable_fields', 'missing_or_uncertain']);
// Legacy records also put characterization results in variables. Keep only preparation inputs.
const preparationVariableName = /ratio|proportion|mass_fraction|geometric_area|thickness|catalyst_load|loading|duration|temperature|time|cycles|repetition|atmosphere|pressure|concentration|dissolved_|^pH$|^x$|^series_x_range$/i;
export const preparationVariables = (sample: Draft['samples'][number]) => (sample.variables ?? []).filter(variable => preparationVariableName.test(variable.name));
function compactSchema(schema: TSchema, legacyDerived = false): TSchema {
  const result = structuredClone(schema) as TSchema & { properties?: Record<string, TSchema>; required?: string[]; items?: TSchema };
  if (result.properties) {
    const isFact = 'raw' in result.properties;
    result.properties = Object.fromEntries(Object.entries(result.properties).filter(([key]) => !excludedFields.has(key)).map(([key, child]) => [key, compactSchema(child as TSchema, legacyDerived)]));
    if (isFact && !legacyDerived) result.properties.status = choice(['reported', 'not_reported', 'source_missing', 'ambiguous', 'conflicting']);
    result.required = (result.required ?? []).filter((key: string) => isFact ? ['raw', 'evidence'].includes(key) : (!omittedFields.has(key) && !(legacyDerived && key === 'phases')));
  }
  if (result.items) result.items = compactSchema(result.items, legacyDerived);
  return result;
}
export const CompactDraftSchema = compactSchema(DraftSchema);
export const CompactVerificationSchema = compactSchema(VerificationSchema);
const focusedFields = ['name', 'material_state', 'variables', 'phases', 'method', 'materials', 'steps', 'shared_from', 'unresolved_questions'] as const;
/** 定点修正的数组项只能给 local_id 加要改的字段；其余字段由程序与草稿里的旧项合并，避免模型被迫重写整项。 */
function partialItemSchema(item: TSchema): TSchema {
  const properties = (item as { properties: Record<string, TSchema> }).properties;
  return Type.Object(Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, key === 'local_id' ? value : Type.Optional(value)])) as Record<string, TSchema>, strict);
}
const focusedChanges = compactSchema(Type.Object(Object.fromEntries(
  focusedFields.map(key => [key, Type.Optional(['steps', 'materials', 'phases'].includes(key)
    ? Type.Array(partialItemSchema((SampleSchema.properties[key] as { items: TSchema }).items))
    : SampleSchema.properties[key])])), strict));
export const FocusedRepairSchema = Type.Object({
  patches: Type.Array(Type.Object({ sample_local_id: text, clear_steps: Type.Optional(Type.Boolean()), changes: focusedChanges }, strict)),
  add_samples: Type.Optional(Type.Array((CompactDraftSchema as typeof DraftSchema).properties.samples.items)),
}, strict);
/** 用草稿里真实存在的样品 ID 约束 patch，避免模型照抄核验报告里 s1 这类索引式 ID 而引用到不存在的样品。 */
export function focusedRepairSchema(draft: Draft): TSchema {
  // 不给枚举：模型常把样品写成 s1/s2，硬枚举会让整轮修正在结构校验就失败；
  // 真实 ID 与索引式 ID 都交给 applyFocusedRepair 里的 resolveSampleId 解析。
  const ids = draft.samples.map(sample => sample.local_id).filter((id): id is string => typeof id === 'string' && !!id);
  const sampleId = ids.length ? Type.Union([text, Type.Literal(ids[0])]) : text;
  return Type.Object({
    patches: Type.Array(Type.Object({ sample_local_id: sampleId, clear_steps: Type.Optional(Type.Boolean()), changes: focusedChanges }, strict)),
    add_samples: Type.Optional(Type.Array((CompactDraftSchema as typeof DraftSchema).properties.samples.items)),
  }, strict);
}

/** 把模型给的样品指代解析成草稿里的真实 ID：真实 ID 直接用，s1/s2/sample_3 这类索引式按出现顺序映射。 */
function resolveSampleId(draft: Draft, raw: string): string | undefined {
  const value = String(raw ?? '').trim();
  if (draft.samples.some(sample => sample.local_id === value)) return value;
  const indexed = /^s(?:ample)?[_\-\s]?(\d+)$/i.exec(value);
  if (!indexed) return undefined;
  const at = Number(indexed[1]) - 1;
  return draft.samples[at]?.local_id;
}
const LegacyCompactDraftSchema = compactSchema(DraftSchema, true);

/** 定点修正里带 local_id 的数组按 ID 合并：patch 未提及的条目由程序原样保留，避免「只写要改的那一项」导致其余条目被静默删除。 */
function mergeById<T extends { local_id: string }>(existing: T[], incoming: T[]): T[] {
  const result = existing.map(item => structuredClone(item));
  const index = new Map(result.map((item, position) => [item.local_id, position]));
  for (const item of incoming) {
    const position = index.get(item.local_id);
    if (position === undefined) { index.set(item.local_id, result.length); result.push(item); }
    else result[position] = { ...result[position], ...item };
  }
  return result;
}

/** variables 没有 local_id，按 name 合并。 */
function mergeByName<T extends { name: string }>(existing: T[], incoming: T[]): T[] {
  const result = existing.map(item => structuredClone(item));
  const index = new Map(result.map((item, position) => [item.name, position]));
  for (const item of incoming) {
    const position = index.get(item.name);
    if (position === undefined) { index.set(item.name, result.length); result.push(item); }
    else result[position] = item;
  }
  return result;
}

export function applyFocusedRepair(response: string, draft: Draft): Draft {
  const patch = parseOutput(response, focusedRepairSchema(draft)) as { patches: { sample_local_id: string; clear_steps?: boolean; changes: Partial<Draft['samples'][number]> }[]; add_samples?: Draft['samples'] };
  const result = structuredClone(draft), seen = new Set<string>();
  for (const entry of patch.patches) {
    const targetId = resolveSampleId(result, entry.sample_local_id);
    if (!targetId) throw new Error('定点修正引用了未知样品');
    if (seen.has(targetId)) throw new Error('同一样品只能提供一组定点修正');
    seen.add(targetId);
    const sample = result.samples.find(s => s.local_id === targetId);
    if (!sample) throw new Error('定点修正引用了未知样品');
    if (entry.clear_steps && entry.changes.steps?.length !== 0) throw new Error('clear_steps只能与明确的空步骤数组共同使用');
    if (!entry.clear_steps && entry.changes.steps?.length === 0 && sample.steps.length) delete entry.changes.steps;
    // 数组字段合并而非替换：模型只需给出要改的条目，其余由程序保留。
    const changes = { ...entry.changes } as Record<string, unknown>;
    for (const key of ['steps', 'materials', 'phases'] as const) {
      const incoming = changes[key];
      if (Array.isArray(incoming) && incoming.length) {
        changes[key] = mergeById((sample[key] ?? []) as { local_id: string }[], incoming as { local_id: string }[]);
      }
    }
    if (Array.isArray(changes.variables) && changes.variables.length) {
      changes.variables = mergeByName(sample.variables as { name: string }[], changes.variables as { name: string }[]);
    }
    // 先合并再裁剪：compactDraft 会移除被排除字段与空数组，但它同时会删掉必填的 notes，这里补回。
    const merged = { ...structuredClone(sample), ...changes } as unknown as Draft['samples'][number];
    const compacted = compactDraft({ assessment: draft.assessment, notes: [], samples: [merged] } as unknown as Draft) as { samples?: Draft['samples'] };
    const carrier = { assessment: draft.assessment, notes: [], samples: compacted.samples ?? [] };
    const parsed = parseDraft(JSON.stringify(carrier)).samples[0];
    for (const key of Object.keys(changes) as (keyof typeof entry.changes)[]) Object.assign(sample, { [key]: parsed[key] });
  }
  if (patch.add_samples?.length) {
    const added = parseDraft(JSON.stringify({ assessment: draft.assessment, notes: [], samples: patch.add_samples })).samples;
    for (const sample of added) {
      if (result.samples.some(existing => existing.local_id === sample.local_id)) throw new Error('新增分支的样品ID已存在');
      result.samples.push(sample);
    }
  }
  return parseOutput(JSON.stringify(result), DraftSchema);
}

export function compactDraft(draft: Draft): unknown {
  const trim = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(trim).filter(item => item !== undefined);
    if (!entry || typeof entry !== 'object') return entry;
    const object = entry as Record<string, unknown>;
    if (object.status === 'not_reported' || (object.fact as Fact | undefined)?.status === 'not_reported') return undefined;
    return Object.fromEntries(Object.entries(object).flatMap(([key, child]) => {
      if (excludedFields.has(key)) return [];
      if ('raw' in object && ((key === 'value' && child === object.raw) || (key === 'status' && child === 'reported') || (key === 'unit' && child === null) || (key === 'note' && child === ''))) return [];
      const value = trim(child);
      if (value === undefined || (omittedFields.has(key) && (value === null || (Array.isArray(value) && !value.length)))) return [];
      return [[key, value]];
    }));
  };
  return trim({ ...draft, samples: draft.samples.map(sample => ({ ...sample, variables: preparationVariables(sample) })) });
}

const emptyFact = (): Fact => ({ raw: null, value: null, unit: null, status: 'not_reported', evidence: [], note: '' });
export function parseDraft(response: string): Draft {
  const full = parseModelJson(response);
  // 纯度是表征结果、不属于抽取范围（compact schema 不含 purity），但 max 档模型常主动写它。
  // 先按原样校验；只有因为它不合格时，才丢弃纯度重试，避免误删本来就合法的数据。
  const dropPurity = (): void => {
    const walk = (entry: unknown): void => {
      if (Array.isArray(entry)) { for (const item of entry) walk(item); return; }
      if (!entry || typeof entry !== 'object') return;
      const object = entry as Record<string, unknown>;
      delete object.purity;
      for (const value of Object.values(object)) walk(value);
    };
    walk(full);
  };
  if (Check(DraftSchema, full)) return full as Draft;
  dropPurity();
  if (Check(DraftSchema, full)) return full as Draft;
  // Some providers put paper-wide questions at the root. Preserve them as notes,
  // without changing any scientific fact or tolerating other unknown fields.
  if (full && typeof full === 'object' && !Array.isArray(full)) {
    const object = full as Record<string, unknown>;
    if (Array.isArray(object.unresolved_questions)) {
      object.notes = [...(Array.isArray(object.notes) ? object.notes : []), ...object.unresolved_questions];
      delete object.unresolved_questions;
    }
    // Place a paper-level material only in samples whose steps explicitly refer to it.
    // This changes organization, never the ingredient, amount or sample assignment.
    if (Array.isArray(object.materials) && Array.isArray(object.samples)) {
      const shared = object.materials as Draft['samples'][number]['materials'];
      if (shared.some(material => !material || typeof material.local_id !== 'string') || new Set(shared.map(material => material.local_id)).size !== shared.length) throw new Error('公共原料缺少唯一 ID');
      for (const sample of object.samples as Draft['samples']) {
        const refs = new Set((sample.steps ?? []).flatMap(step => step.material_refs ?? []));
        const own = new Set((sample.materials ?? []).map(material => material.local_id));
        sample.materials = [...(sample.materials ?? []), ...shared.filter(material => refs.has(material.local_id) && !own.has(material.local_id)).map(material => structuredClone(material))];
      }
      delete object.materials;
    }
    if (Array.isArray(object.samples)) for (const sample of object.samples as Record<string, unknown>[]) {
      for (const [list, field] of [['steps', 'operation'], ['materials', 'identity']] as const) {
        if (!Array.isArray(sample[list])) continue;
        for (const entry of sample[list] as Record<string, unknown>[]) {
          const target = entry[field];
          if (typeof entry.note !== 'string' || !target || typeof target !== 'object' || !('raw' in target)) continue;
          const fact = target as Record<string, unknown>;
          if (fact.note !== undefined && typeof fact.note !== 'string') continue;
          fact.note = [fact.note, entry.note].filter(Boolean).join('\n');
          delete entry.note;
        }
      }
    }
  }
  if (Check(DraftSchema, full)) return full as Draft;
  const value = parseOutput(JSON.stringify(full), LegacyCompactDraftSchema) as Draft;
  const expandFacts = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(expandFacts);
    if (!entry || typeof entry !== 'object') return entry;
    const object = entry as Record<string, unknown>;
    if ('raw' in object) return { ...emptyFact(), value: object.raw, status: object.raw === null ? 'not_reported' : 'reported', ...object };
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, expandFacts(child)]));
  };
  const draft = expandFacts(value) as Draft;
  draft.notes ??= [];
  for (const sample of draft.samples) {
    sample.aliases ??= []; sample.variables ??= [];
    sample.nominal_composition ??= emptyFact(); sample.measured_composition ??= emptyFact(); sample.method ??= emptyFact();
    sample.materials ??= []; sample.steps ??= []; sample.phases ??= []; sample.shared_from ??= null; sample.unresolved_questions ??= [];
    for (const phase of sample.phases) { phase.formula ??= emptyFact(); phase.purity ??= emptyFact(); }
    for (const material of sample.materials) { material.amount ??= emptyFact(); material.concentration ??= emptyFact(); }
    for (const step of sample.steps) { step.description ??= emptyFact(); step.conditions ??= []; step.material_refs ??= []; }
  }
  return parseOutput(JSON.stringify(draft), DraftSchema);
}
export function parseVerification(response: string): Verification {
  const full = parseModelJson(response);
  if (Check(VerificationSchema, full)) return full as Verification;
  const review = parseOutput(response, CompactVerificationSchema) as Verification;
  review.notes ??= [];
  for (const sample of review.samples) { sample.expandable_fields ??= []; sample.missing_or_uncertain ??= []; }
  return parseOutput(JSON.stringify(review), VerificationSchema);
}

export function parseModelJson(response: string): unknown {
  const trimmed = response.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export function parseOutput<T extends TSchema>(response: string, schema: T): Static<T> {
  const value = parseModelJson(response);
  if (!Check(schema, value)) {
    const errors = [...Errors(schema, value)].slice(0, 8).map(error => `${error.instancePath}: ${error.message}`);
    throw new Error(`模型输出不符合结构：${errors.join('；')}`);
  }
  return value as Static<T>;
}

const normalizeQuote = (value: string) => value.normalize('NFKC').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
export function validateEvidence(evidence: Evidence[], sources: Pick<SourceDocument, 'id' | 'pages'>[], literal = true): string[] {
  return evidence.flatMap(ref => {
    const page = sources.find(source => source.id === ref.source_id)?.pages.find(page => page.number === ref.page);
    if (!page) return [`证据位置不存在：${ref.source_id} 第 ${ref.page} 页`];
    if (ref.basis === 'page_image') return page.image_path ? [] : [`图像证据缺少实际页面图像：${ref.source_id} 第 ${ref.page} 页`];
    if (literal && !normalizeQuote(page.text).includes(normalizeQuote(ref.quote))) return [`证据摘录不在原文中：${ref.source_id} 第 ${ref.page} 页`];
    return [];
  });
}

export function validateDraft(draft: Draft, sources: SourceDocument[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const facts = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(facts); return; }
    const object = value as Record<string, unknown>;
    if ('raw' in object && 'status' in object && 'evidence' in object) {
      const fact = object as Fact;
      errors.push(...validateEvidence(fact.evidence, sources, false));
      if (fact.status === 'reported' && (fact.value === null || !fact.raw || fact.evidence.length === 0)) errors.push('reported 字段必须有原始表达、值和证据');
      if (fact.status === 'reported' && fact.raw) {
        if (typeof fact.value === 'number') {
          const numericRaw = fact.raw.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');
          const values = [...numericRaw.matchAll(/[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)].map(match => Number(match[0]));
          if (!values.includes(fact.value)) errors.push('数值不对应原始表达；模型不能自行换算或填补');
        }
      }
      if (['not_reported', 'source_missing'].includes(fact.status) && fact.value !== null) errors.push('缺失字段不能填写确定值');
      return;
    }
    Object.values(object).forEach(facts);
  };
  for (const sample of draft.samples) {
    if (ids.has(sample.local_id)) errors.push(`重复样品 ID：${sample.local_id}`);
    ids.add(sample.local_id);
    for (const phase of sample.phases) {
      if (phase.metal_elements?.status === 'reported' && !derivePhaseMetalElements(phase, true)) errors.push(`相 ${phase.local_id} 的金属元素无效或与明确化学式冲突`);
      if (phase.formula.status === 'reported' && typeof phase.formula.value === 'string' && phase.formula.raw) {
        const compact = normalizeFormula;
        const escaped = compact(phase.formula.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // A substring can omit a metal or coefficient, changing the future matching result.
        const completeFormula = new RegExp(`(^|[^A-Za-z0-9()\\[\\]+δ-])${escaped}(?![A-Za-z0-9()\\[\\]+δ-]|\\.\\d)`);
        if (!completeFormula.test(compact(phase.formula.raw))) errors.push(`相 ${phase.local_id} 的化学式规范值不对应完整原文表达`);
      }
    }
    for (const entries of [sample.phases, sample.materials, sample.steps]) {
      if (new Set(entries.map(entry => entry.local_id)).size !== entries.length) errors.push(`样品 ${sample.local_id} 内存在重复 ID`);
    }
    const materialIds = new Set(sample.materials.map(material => material.local_id));
    const inheritedIds = new Map<string, number>();
    const visitedParents = new Set([sample.local_id]);
    let parentId = sample.shared_from;
    while (parentId && !visitedParents.has(parentId)) {
      visitedParents.add(parentId);
      const parent = draft.samples.find(candidate => candidate.local_id === parentId);
      if (!parent) break;
      for (const material of parent.materials) {
        materialIds.add(`${parent.local_id}.${material.local_id}`);
        inheritedIds.set(material.local_id, (inheritedIds.get(material.local_id) ?? 0) + 1);
      }
      parentId = parent.shared_from;
    }
    for (const [materialId, count] of inheritedIds) if (count === 1) materialIds.add(materialId);
    for (const step of sample.steps) if (step.material_refs.some(id => !materialIds.has(id))) errors.push(`步骤 ${step.local_id} 引用了不存在的原料`);
  }
  for (const sample of draft.samples) {
    const visited = new Set([sample.local_id]);
    let parent = sample.shared_from;
    while (parent) {
      if (visited.has(parent)) { errors.push(`样品 ${sample.local_id} 的共用步骤关系成环`); break; }
      visited.add(parent);
      const next = draft.samples.find(candidate => candidate.local_id === parent);
      if (!next) { errors.push(`不存在的共用样品：${parent}`); break; }
      parent = next.shared_from;
    }
  }
  facts(draft);
  return errors;
}

export interface DraftReviewNote { kind: 'quote_mismatch' | 'raw_mismatch' | 'derived' | 'phase_membership'; field_path: string; message: string }
/** Semantic questions reach the verifier instead of becoming pre-model rejection. */
export function draftReviewNotes(draft: Draft, sources: SourceDocument[]): DraftReviewNote[] {
  const notes: DraftReviewNote[] = [];
  const quotes = new Set<string>();
  const walk = (entry: unknown, path: string): void => {
    if (!entry || typeof entry !== 'object') return;
    if (Array.isArray(entry)) { entry.forEach((child, index) => walk(child, `${path}[${index}]`)); return; }
    const object = entry as Record<string, unknown>;
    if ('raw' in object && 'status' in object && 'evidence' in object) {
      const fact = object as Fact;
      for (const ref of fact.evidence) {
        const key = `${ref.source_id}:${ref.page}:${ref.quote}`;
        if (!quotes.has(key) && validateEvidence([ref], sources).length) {
          quotes.add(key);
          notes.push({ kind: 'quote_mismatch', field_path: path, message: `引文与文字层不同，需对照${ref.source_id}第${ref.page}页原图或原文判断；不能仅据OCR差异认定事实错误` });
        }
      }
      if (fact.status === 'reported' && fact.raw && !fact.evidence.some(ref => normalizeFormula(ref.quote).includes(normalizeFormula(fact.raw!)))) notes.push({ kind: 'raw_mismatch', field_path: path, message: 'raw不连续对应引文；核查是排版/名称释义还是实质补写，必要时指出正确原文表达' });
      if (fact.status === 'derived') notes.push({ kind: 'derived', field_path: path, message: `抽取模型自行推导了${JSON.stringify(fact.value)}；蒸馏提示词不允许把推算结果作为论文报告的实验条件，须核对并指出删除或原文依据` });
      return;
    }
    for (const [key, child] of Object.entries(object)) walk(child, path ? `${path}.${key}` : key);
  };
  walk(draft, '');
  for (const [index, sample] of draft.samples.entries()) for (const phase of sample.phases) {
    if (phase.metal_elements?.status === 'reported' && !derivePhaseMetalElements(phase)) notes.push({ kind: 'phase_membership', field_path: `samples[${index}].phases.${phase.local_id}.metal_elements`, message: '名称或变量式不能靠符号正则确认：请根据目标相证据确认完整金属集合，特别检查变量可能为零的端点' });
  }
  return notes;
}

const elements = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' '));
const nonmetals = new Set('H He B C N O F Ne Si P S Cl Ar Ge As Se Br Kr Sb Te I Xe At Rn Ts Og'.split(' '));
export function deriveMetalElements(formula: string): string[] | null {
  // An oxygen deficiency does not alter the metal set; unresolved metal substitutions do.
  const normalized = normalizeFormula(formula)
    .replace(/(O\d+(?:\.\d+)?)[+-](?:δ|x)$/, '$1');
  let cursor = 0;
  const metals = new Set<string>();
  const coefficient = () => {
    const match = /^\d+(?:\.\d+)?/.exec(normalized.slice(cursor));
    if (!match) return true;
    cursor += match[0].length;
    return Number(match[0]) > 0;
  };
  const sequence = (insideGroup: boolean): boolean => {
    let terms = 0;
    while (cursor < normalized.length && normalized[cursor] !== ')') {
      if (normalized[cursor] === '(') {
        cursor++;
        if (!sequence(true) || normalized[cursor] !== ')') return false;
        cursor++;
        if (!coefficient()) return false;
      } else {
        const atom = /^[A-Z][a-z]?/.exec(normalized.slice(cursor));
        if (!atom || !elements.has(atom[0])) return false;
        cursor += atom[0].length;
        if (!coefficient()) return false;
        if (!nonmetals.has(atom[0])) metals.add(atom[0]);
      }
      terms++;
    }
    return terms > 0 && (insideGroup || cursor === normalized.length);
  };
  if (!sequence(false) || cursor !== normalized.length) return null;
  return metals.size ? [...metals].sort() : null;
}

/** Equivalent typography only; a variable or unknown coefficient is never evaluated. */
export function normalizeFormula(formula: string): string {
  return formula.normalize('NFKC').replace(/\s/g, '').replace(/[−–]/g, '-')
    .replace(/\\(?:mathrm|text|ce)\{([^{}]*)\}/g, '$1')
    .replace(/_\{([^{}]+)\}/g, '$1').replace(/_(\d+(?:\.\d+)?)/g, '$1');
}

/** Explicit phase membership is distinct from a sample's precursor or support composition. */
export function derivePhaseMetalElements(phase: Pick<Static<typeof PhaseSchema>, 'formula' | 'metal_elements'>, verifiedMembership = false): string[] | null {
  const exact = phase.formula.status === 'reported' && typeof phase.formula.value === 'string' ? deriveMetalElements(phase.formula.value) : null;
  const fact = phase.metal_elements;
  if (!fact || fact.status !== 'reported') return exact;
  if (!fact.raw || !fact.evidence.length || !Array.isArray(fact.value) || !fact.value.length) return null;
  const declared = [...new Set(fact.value)].sort();
  const mentioned = new Set(fact.raw.normalize('NFKC').match(/[A-Z][a-z]?/g) ?? []);
  if (declared.some(symbol => !elements.has(symbol) || nonmetals.has(symbol))) return null;
  if (exact && exact.join('|') !== declared.join('|')) return null;
  if (!exact && !verifiedMembership && declared.some(symbol => !mentioned.has(symbol))) return null;
  return declared;
}
