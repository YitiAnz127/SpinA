import { preparationChain } from '../distillation/preparation.ts';
import { checkContinuity, fingerprintDraft, type SampleFingerprint } from './specimen-identity.ts';
import { preparationVariables, type Fact } from '../distillation/schema.ts';
import type { PublishedRecord, RecordReference } from '../distillation/store.ts';
import type { Observation, ResearchStore, ScientificClaim } from './store.ts';

/**
 * F2: within-paper sample series.
 *
 * This compares experimental design, not performance: which variables the authors actually
 * changed, which were held constant, which are unreported, and whether the reported
 * observations can support a single-variable attribution.
 */

export interface ConditionField {
  key: string;
  label: string;
  value: string;
  status: Fact['status'];
  comparable: boolean;
  sample_id: string;
  field_path: string;
}

export interface FieldDifference {
  key: string;
  label: string;
  control: ConditionField;
  treatment: ConditionField;
}

export interface UnresolvedField {
  key: string;
  label: string;
  reason: 'unreported' | 'not_aligned';
  control: ConditionField | null;
  treatment: ConditionField | null;
}

export interface ObservationComparison {
  metric: string;
  control: Observation | null;
  treatment: Observation | null;
  /** Strict comparability: same unit, method, context and record revision. */
  comparable: boolean;
  comparability: 'comparable' | 'incomparable';
  delta: number | null;
  reason: string;
  context_status: 'matched' | 'unknown' | 'mismatched';
  evidence_version: {
    control: RecordReference | null;
    treatment: RecordReference | null;
    current: RecordReference;
    status: 'current' | 'stale' | 'unbound';
  };
}

export interface SeriesContrast {
  sample_id: string;
  varied: FieldDifference[];
  held_constant: ConditionField[];
  unreported: UnresolvedField[];
  not_aligned: UnresolvedField[];
  confounded: boolean;
  observations: ObservationComparison[];
  assessment: {
    status: 'insufficient_observations' | 'cannot_isolate_variable' | 'measurement_not_comparable' | 'single_variable_contrast' | 'no_variation' | 'partially_controlled' | 'unresolved_design';
    explanation: string;
  };
}

export interface StudyContrast {
  paper_id: string;
  record_ref: RecordReference;
  control: string;
  series: { sample_ids: string[]; basis: 'shared_preparation' | 'same_paper_target_phase' };
  contrasts: SeriesContrast[];
  author_claims: { claim_id: string; statement: string; stance: string }[];
  unresolved: string[];
  provenance: 'deterministic_analysis';
}

const normalizeValue = (value: string) => value.normalize('NFKC').toLowerCase()
  .replace(/[−–—]/g, '-').replace(/℃/g, '°c').replace(/\s+/g, ' ').trim();

const display = (fact: Fact): string => {
  if (fact.status === 'not_reported' || fact.status === 'source_missing') return '';
  const value = Array.isArray(fact.value) ? fact.value.join('、') : fact.value;
  const text = fact.raw ?? (value === null ? '' : String(value));
  return fact.unit && typeof text === 'string' && !text.includes(fact.unit) ? `${text} ${fact.unit}` : String(text);
};

function field(key: string, label: string, fact: Fact, sampleId: string, fieldPath: string): ConditionField {
  const text = display(fact);
  return {
    key, label, value: text, status: fact.status,
    comparable: fact.status === 'reported' && Boolean(text.trim()), sample_id: sampleId, field_path: fieldPath,
  };
}

/** Build a comparable condition vector from a sample and its explicit shared ancestors. */
export function conditionVector(record: PublishedRecord, sampleId: string): Map<string, ConditionField> {
  const chain = preparationChain(record.draft, sampleId);
  const fields = new Map<string, ConditionField>();
  const add = (item: ConditionField) => { if (!fields.has(item.key)) fields.set(item.key, item); };
  for (const sample of chain) {
    for (const variable of preparationVariables(sample)) {
      add(field(`variable:${variable.name}`, `变量 ${variable.name}`, variable.fact, sample.local_id,
        `samples.${sample.local_id}.variables.${variable.name}`));
    }
    const seen = new Map<string, number>();
    for (const step of sample.steps) {
      for (const condition of step.conditions) {
        const index = (seen.get(condition.name) ?? 0) + 1;
        seen.set(condition.name, index);
        add(field(`condition:${condition.name}#${index}`, `条件 ${condition.name}${index > 1 ? ` #${index}` : ''}`, condition.fact, sample.local_id,
          `samples.${sample.local_id}.steps.${step.local_id}.conditions.${condition.name}`));
      }
    }
    if (sample.method.status === 'reported' || sample.method.raw) {
      add(field('method', '方法', sample.method, sample.local_id, `samples.${sample.local_id}.method`));
    }
    const materials = sample.materials.map(material => display(material.identity)).filter(Boolean).sort();
    if (materials.length) {
      add({
        key: 'materials.set', label: '原料集合', value: materials.join('；'), status: 'reported', comparable: true,
        sample_id: sample.local_id, field_path: `samples.${sample.local_id}.materials`,
      });
    }
  }
  return fields;
}

function compareFields(control: Map<string, ConditionField>, treatment: Map<string, ConditionField>) {
  const varied: FieldDifference[] = [], held: ConditionField[] = [], unreported: UnresolvedField[] = [], notAligned: UnresolvedField[] = [];
  for (const key of new Set([...control.keys(), ...treatment.keys()])) {
    const left = control.get(key) ?? null, right = treatment.get(key) ?? null;
    if (left && right) {
      if (left.comparable && right.comparable) {
        if (normalizeValue(left.value) === normalizeValue(right.value)) held.push(left);
        else varied.push({ key, label: left.label, control: left, treatment: right });
      } else unreported.push({ key, label: left.label, reason: 'unreported', control: left, treatment: right });
    } else {
      const present = left ?? right;
      if (!present) continue;
      if (!present.comparable) unreported.push({ key, label: present.label, reason: 'unreported', control: left, treatment: right });
      else notAligned.push({ key, label: present.label, reason: 'not_aligned', control: left, treatment: right });
    }
  }
  return { varied, held, unreported, notAligned };
}

function compareObservations(store: ResearchStore | null, paperId: string, control: string, treatment: string, currentRef: RecordReference, current: SampleFingerprint[] = []): ObservationComparison[] {
  if (!store) return [];
  const byMetric = (sampleId: string) => {
    const map = new Map<string, Observation[]>();
    for (const observation of store.listObservations(paperId, sampleId)) {
      const key = observation.metric.normalize('NFKC').toLowerCase().trim();
      const group = map.get(key) ?? [];
      group.push(observation);
      map.set(key, group);
    }
    return map;
  };
  const versionStatus = (observation: Observation | null): 'current' | 'stale' | 'unbound' => {
    if (!observation?.record_ref) return 'unbound';
    const ref = observation.record_ref;
    return ref.version === currentRef.version && ref.revision === currentRef.revision && ref.verified_at === currentRef.verified_at ? 'current' : 'stale';
  };
  const left = byMetric(control), right = byMetric(treatment);
  const results: ObservationComparison[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const controls = left.get(key) ?? [], treatments = right.get(key) ?? [];
    if (controls.length > 1 || treatments.length > 1) {
      for (const item of controls) results.push({ metric: key, control: item, treatment: null, comparable: false, comparability: 'incomparable', delta: null, context_status: 'unknown', evidence_version: { control: item.record_ref ?? null, treatment: null, current: currentRef, status: versionStatus(item) }, reason: '同一指标有多个观测，请指定配对' });
      for (const item of treatments) results.push({ metric: key, control: null, treatment: item, comparable: false, comparability: 'incomparable', delta: null, context_status: 'unknown', evidence_version: { control: null, treatment: item.record_ref ?? null, current: currentRef, status: versionStatus(item) }, reason: '同一指标有多个观测，请指定配对' });
      continue;
    }
    const a = controls[0] ?? null, b = treatments[0] ?? null;
    const statuses = [versionStatus(a), versionStatus(b)];
    const evidenceVersion = {
      control: a?.record_ref ?? null, treatment: b?.record_ref ?? null, current: currentRef,
      status: statuses.includes('stale') ? 'stale' as const : statuses.every(status => status === 'unbound') ? 'unbound' as const : 'current' as const,
    };
    if (!a || !b) {
      results.push({ metric: key, control: a, treatment: b, comparable: false, comparability: 'incomparable', delta: null, context_status: 'unknown', evidence_version: evidenceVersion, reason: '只有一方报告了该指标，不能比较' });
      continue;
    }
    if ((a.unit ?? '') !== (b.unit ?? '')) {
      results.push({ metric: key, control: a, treatment: b, comparable: false, comparability: 'incomparable', delta: null, context_status: 'unknown', evidence_version: evidenceVersion, reason: `单位不同（${a.unit ?? '未记录'} vs ${b.unit ?? '未记录'}）` });
      continue;
    }
    if (evidenceVersion.status === 'stale') {
      const refs = [a.record_ref, b.record_ref].filter((ref): ref is RecordReference => Boolean(ref)).map(ref => `r${ref.revision}@${ref.verified_at}`);
      // The fingerprint separates "the paper was re-distilled" from "this sample is now a
      // different material", which changes what the reader has to do next.
      const continuity = [a, b].map(observation => checkContinuity(observation.sample_fingerprint ?? null, current, observation.sample_id));
      const changed = continuity.filter(item => item.status === 'redefined' || item.status === 'missing');
      const detail = changed.length
        ? `样品已不是原记录中的材料：${changed.map(item => item.explanation).join('；')}`
        : continuity.every(item => item.status === 'same_specimen' || item.status === 'unverifiable')
          ? '样品化学指纹未变，但修订已更新；需按当前版本复核数值后再用'
          : `样品归属需人工确认：${continuity.map(item => item.explanation).join('；')}`;
      results.push({ metric: key, control: a, treatment: b, comparable: false, comparability: 'incomparable', delta: null, context_status: 'unknown', evidence_version: evidenceVersion,
        reason: `观察绑定修订 ${refs.join('、')}，当前记录为 r${currentRef.revision}@${currentRef.verified_at}；${detail}` });
      continue;
    }
    const contextKeys = new Set([...Object.keys(a.context), ...Object.keys(b.context)]);
    const mismatch = [...contextKeys].filter(contextKey => (a.context[contextKey] ?? '') !== (b.context[contextKey] ?? ''));
    const numericA = typeof a.value === 'number' ? a.value : Number(a.value);
    const numericB = typeof b.value === 'number' ? b.value : Number(b.value);
    const delta = Number.isFinite(numericA) && Number.isFinite(numericB) ? Number((numericB - numericA).toFixed(6)) : null;
    if (mismatch.length) {
      results.push({ metric: key, control: a, treatment: b, comparable: false, comparability: 'incomparable', delta: null, context_status: 'mismatched', evidence_version: evidenceVersion, reason: `测量条件不一致：${mismatch.join('、')}` });
      continue;
    }
    const methodMissing = !a.method?.trim() || !b.method?.trim();
    const contextMissing = !contextKeys.size || [...contextKeys].some(contextKey => !a.context[contextKey]?.trim() || !b.context[contextKey]?.trim());
    if (methodMissing || a.method !== b.method || contextMissing) {
      results.push({ metric: key, control: a, treatment: b, comparable: false, comparability: 'incomparable', delta: null, context_status: 'unknown', evidence_version: evidenceVersion,
        reason: '单位、测量方法或测量条件缺失或不一致，不能建立定量对比' });
      continue;
    }
    results.push({ metric: key, control: a, treatment: b, comparable: true, comparability: 'comparable', delta, context_status: 'matched', evidence_version: evidenceVersion,
      reason: delta === null ? '双方均报告且条件一致（非数值指标）' : `同单位、同测量方法及条件下差值 ${delta}` });
  }
  return results;
}

function assess(contrast: Omit<SeriesContrast, 'assessment'>): SeriesContrast['assessment'] {
  const comparable = contrast.observations.filter(item => item.comparable);
  const anyObservation = contrast.observations.length > 0;
  const gaps = contrast.unreported.length + contrast.not_aligned.length;
  if (contrast.confounded) {
    return {
      status: 'cannot_isolate_variable',
      explanation: `同时改变了 ${contrast.varied.length} 个变量（${contrast.varied.map(item => item.label).join('、')}），不能把观察差异单独归因于其中任何一个。`,
    };
  }
  if (contrast.varied.length === 0) {
    return gaps
      ? { status: 'unresolved_design', explanation: `没有识别到已报告的变量差异，但有 ${gaps} 个条件未报告或名称未对齐，无法确认设计是否只改变了一个变量。` }
      : { status: 'no_variation', explanation: '与对照相比没有识别到已报告的变量差异。' };
  }
  if (gaps) {
    return {
      status: 'partially_controlled',
      explanation: `只有「${contrast.varied[0].label}」在已报告字段中不同，但仍有 ${gaps} 个条件未报告或未对齐，不能断言其他条件保持一致。`,
    };
  }
  if (!anyObservation) {
    return { status: 'insufficient_observations', explanation: '设计上只有一个变量不同，但库内没有绑定到这两个样品的结果观察，无法判断效应。' };
  }
  if (!comparable.length) {
    return { status: 'measurement_not_comparable', explanation: '有观察记录，但单位、测量方法、测量条件或记录修订版不一致，不能直接比较。' };
  }
  return { status: 'single_variable_contrast', explanation: `只有「${contrast.varied[0].label}」不同，且有同方法、同条件的可比观察；这仍只是对照关系，不是因果证明。` };
}

export interface SeriesOptions { control?: string; samples?: string[] }

/** Analyze a within-paper series; cross-paper pooling is deliberately not supported. */
export function analyzeSampleSeries(record: PublishedRecord, version: RecordReference['version'], store: ResearchStore | null, options: SeriesOptions = {}): StudyContrast {
  const targetSamples = record.draft.samples.filter(sample => sample.phases.some(phase => phase.role === 'target_spinel'));
  const selected = options.samples?.length
    ? options.samples.map(id => {
        const sample = record.draft.samples.find(item => item.local_id === id);
        if (!sample) throw new Error(`样品不存在：${id}`);
        return sample;
      })
    : targetSamples;
  if (new Set(selected.map(sample => sample.local_id)).size !== selected.length) throw new Error('系列分析需要不同的样品');
  if (selected.length < 2) throw new Error('系列分析至少需要两个含目标相的样品');
  const vectors = new Map(selected.map(sample => [sample.local_id, conditionVector(record, sample.local_id)]));
  const control = options.control ?? [...vectors.entries()]
    .sort((a, b) => [...b[1].values()].filter(item => item.comparable).length - [...a[1].values()].filter(item => item.comparable).length || a[0].localeCompare(b[0]))[0][0];
  if (!vectors.has(control)) throw new Error(`对照样品不存在：${control}`);
  const controlVector = vectors.get(control)!;

  const unresolved: string[] = [];
  // A series shares at least one node in its preparation chains (the control itself may be that node).
  const chains = selected.map(sample => new Set(preparationChain(record.draft, sample.local_id).map(item => item.local_id)));
  const sharedAncestor = [...chains[0]].some(id => chains.every(chain => chain.has(id)));
  if (!sharedAncestor) unresolved.push('样品不共享同一显式父流程；系列关系按同论文目标相样品推断，需人工确认是否同批实验');
  unresolved.push('条件比较按文本归一化；不同单位的同一物理量不会被自动换算，可能被记为不同。');
  unresolved.push('空字段按“未报告”处理，不视为控制变量一致。');

  const contrasts: SeriesContrast[] = selected.filter(sample => sample.local_id !== control).map(sample => {
    const compared = compareFields(controlVector, vectors.get(sample.local_id)!);
    const observations = compareObservations(store, record.paper.paper_id, control, sample.local_id,
      { paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at },
      fingerprintDraft(record.draft));
    const partial = {
      sample_id: sample.local_id, varied: compared.varied, held_constant: compared.held,
      unreported: compared.unreported, not_aligned: compared.notAligned,
      confounded: compared.varied.length > 1, observations,
    };
    return { ...partial, assessment: assess(partial) };
  });

  const claims: ScientificClaim[] = (store?.listClaims(record.paper.paper_id) ?? []).filter(claim => claim.kind === 'author_interpretation');
  return {
    paper_id: record.paper.paper_id,
    record_ref: { paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at },
    control,
    series: { sample_ids: selected.map(sample => sample.local_id), basis: sharedAncestor ? 'shared_preparation' : 'same_paper_target_phase' },
    contrasts,
    author_claims: claims.map(claim => ({ claim_id: claim.claim_id, statement: claim.statement, stance: claim.stance })),
    unresolved,
    provenance: 'deterministic_analysis',
  };
}
