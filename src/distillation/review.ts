import { Check } from 'typebox/value';
import { randomUUID } from 'node:crypto';
import { FactSchema, VerificationSchema, DraftSchema, derivePhaseMetalElements, type Draft, type Evidence, type Fact } from './schema.ts';
import type { ExperimentStore, PublishedRecord, ReviewAction, ReviewActionKind, RecordReference, HumanReview } from './store.ts';
import { preparationChain } from './preparation.ts';
import { isExtractionIssue, issueText, missingInformation, sourceLimitations } from './missing-information.ts';
import { matchingEntries } from './pipeline.ts';

type Issue = PublishedRecord['verification']['issues'][number];

export const REVIEW_CATEGORIES = ['matching', 'value_unit', 'step_attribution', 'source'] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];
export const CATEGORY_LABELS: Record<ReviewCategory, string> = {
  matching: '影响目标相匹配',
  value_unit: '数值或单位错误',
  step_attribution: '步骤归属',
  source: '来源缺失或冲突',
};

/** Categories follow the reviewer's decision, not the model's issue taxonomy alone. */
export function issueCategory(issue: Issue): ReviewCategory {
  if (issue.affects_matching || ['composition_or_phase_error', 'sample_mismatch'].includes(issue.issue_type)) return 'matching';
  if (['numeric_error', 'unit_error'].includes(issue.issue_type)) return 'value_unit';
  if (['step_assignment_error', 'step_omission'].includes(issue.issue_type)) return 'step_attribution';
  return 'source';
}

const CATEGORY_ORDER: Record<ReviewCategory, number> = { matching: 0, value_unit: 1, step_attribution: 2, source: 3 };
const STATUS_ORDER: Record<string, number> = { confirmed_error: 0, unresolved: 1, resolved: 2 };

export interface ReviewIssueRow {
  paper_id: string; title: string; version: RecordReference['version'];
  record_ref: RecordReference; issue_index: number;
  category: ReviewCategory; category_label: string;
  issue_type: string; resolution_status: string; action: string | null;
  affects_matching: boolean; sample_local_id: string | null; field_path: string;
  current_value: string; proposed_correction: string;
  evidence: Evidence[]; evidence_available: boolean;
}

export function listReviewIssues(store: ExperimentStore, options: {
  category?: ReviewCategory; paperId?: string; includeResolved?: boolean; limit?: number; offset?: number;
} = {}): { total: number; rows: ReviewIssueRow[]; offset: number; limit: number; has_more: boolean; next_offset: number | null } {
  const { includeResolved = false, limit = 20, offset = 0 } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 必须为 1–200');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须为非负安全整数');
  const { records } = store.readPublishedVersions(true);
  const rows: ReviewIssueRow[] = [];
  for (const { record, version } of records) {
    if (options.paperId && record.paper.paper_id !== options.paperId) continue;
    record.verification.issues.forEach((issue, issue_index) => {
      if (!includeResolved && issue.resolution_status === 'resolved') return;
      const category = issueCategory(issue);
      if (options.category && category !== options.category) return;
      rows.push({
        paper_id: record.paper.paper_id, title: record.paper.title, version,
        record_ref: { paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at },
        issue_index, category, category_label: CATEGORY_LABELS[category],
        issue_type: issue.issue_type, resolution_status: issue.resolution_status, action: issue.action ?? null,
        affects_matching: issue.affects_matching, sample_local_id: issue.sample_local_id, field_path: issue.field_path,
        current_value: issue.current_value, proposed_correction: issue.proposed_correction,
        evidence: issue.source_evidence, evidence_available: issue.source_evidence.length > 0,
      });
    });
  }
  rows.sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
    (STATUS_ORDER[a.resolution_status] ?? 9) - (STATUS_ORDER[b.resolution_status] ?? 9) ||
    Number(b.affects_matching) - Number(a.affects_matching) ||
    a.paper_id.localeCompare(b.paper_id) || a.issue_index - b.issue_index);
  const page = rows.slice(offset, offset + limit), next = offset + page.length;
  return { total: rows.length, rows: page, offset, limit, has_more: next < rows.length, next_offset: next < rows.length ? next : null };
}

export interface ResolvedField {
  field_path: string; sample_local_id: string; kind: string; fact: Fact;
  context?: { step_id?: string; material_id?: string; phase_id?: string };
}

/** Resolve a stored field by object IDs, never by array offsets. */
export function resolveField(draft: Draft, fieldPath: string): ResolvedField | null {
  const direct = resolveScopedField(draft, fieldPath);
  if (direct) return direct;
  // Model-written issue paths often omit the sample prefix; accept only an unambiguous match.
  if (fieldPath.startsWith('samples.')) return null;
  const matches = draft.samples
    .map(sample => resolveScopedField(draft, `samples.${sample.local_id}.${fieldPath}`))
    .filter((field): field is ResolvedField => Boolean(field));
  return matches.length === 1 ? matches[0] : null;
}

function resolveScopedField(draft: Draft, fieldPath: string): ResolvedField | null {
  const match = /^samples\.([^.]+)\.(.+)$/.exec(fieldPath);
  if (!match) return null;
  const [, sampleId, rest] = match;
  const sample = draft.samples.find(candidate => candidate.local_id === sampleId);
  if (!sample) return null;
  const base = { field_path: fieldPath, sample_local_id: sampleId };
  if (rest === 'method') return { ...base, kind: 'method', fact: sample.method };
  if (rest === 'nominal_composition') return { ...base, kind: 'nominal_composition', fact: sample.nominal_composition };
  if (rest === 'measured_composition') return { ...base, kind: 'measured_composition', fact: sample.measured_composition };
  let part = /^variables\.(.+)$/.exec(rest);
  if (part) {
    const variable = (sample.variables ?? []).find(item => item.name === part![1]);
    return variable ? { ...base, kind: 'variable', fact: variable.fact } : null;
  }
  part = /^materials\.([^.]+)\.(identity|amount|concentration)$/.exec(rest);
  if (part) {
    const material = sample.materials.find(item => item.local_id === part![1]);
    if (!material) return null;
    return { ...base, kind: 'material', fact: material[part[2] as 'identity' | 'amount' | 'concentration'], context: { material_id: material.local_id } };
  }
  part = /^phases\.([^.]+)\.(formula|identity|purity|metal_elements)$/.exec(rest);
  if (part) {
    const phase = sample.phases.find(item => item.local_id === part![1]);
    if (!phase) return null;
    const key = part[2] as 'formula' | 'identity' | 'purity' | 'metal_elements';
    const fact = key === 'metal_elements' ? phase.metal_elements : phase[key];
    return fact ? { ...base, kind: `phase_${key}`, fact, context: { phase_id: phase.local_id } } : null;
  }
  part = /^steps\.([^.]+)\.(operation|description)$/.exec(rest);
  if (part) {
    const step = sample.steps.find(item => item.local_id === part![1]);
    if (!step) return null;
    return { ...base, kind: `step_${part[2]}`, fact: step[part[2] as 'operation' | 'description'], context: { step_id: step.local_id } };
  }
  part = /^steps\.([^.]+)\.conditions\.(.+)$/.exec(rest);
  if (part) {
    const step = sample.steps.find(item => item.local_id === part![1]);
    const condition = step?.conditions.find(item => item.name === part![2]);
    return condition ? { ...base, kind: 'step_condition', fact: condition.fact, context: { step_id: step!.local_id } } : null;
  }
  return null;
}

const display = (fact: Fact) => {
  if (fact.status === 'not_reported') return '（原文未报告）';
  const value = Array.isArray(fact.value) ? fact.value.join('、') : fact.value;
  const base = fact.raw ?? (value === null ? '' : String(value));
  return fact.unit && typeof base === 'string' && !base.includes(fact.unit) ? `${base} ${fact.unit}` : base;
};

export interface PaperReviewView {
  paper: PublishedRecord['paper'];
  record_ref: RecordReference;
  revision: number;
  verification_status: 'verified' | 'uncertain';
  verified_by: string;
  verified_at: string;
  sources: { id: string; path: string; kind: string; page_count: number }[];
  samples: {
    sample_id: string; name: string; material_state: string; shared_from: string | null;
    phases: { phase_id: string; role: string; formula: string; identity: string }[];
    materials: { material_id: string; identity: string; amount: string }[];
    steps: { step_id: string; operation: string; conditions: { name: string; value: string; field_path: string; status: string }[] }[];
  }[];
  issues: (ReviewIssueRow & { resolved_field: ResolvedField | null })[];
  missing_information: { sample_id: string | null; field_path: string; message: string }[];
  source_limitations: { sample_id: string | null; field_path: string; message: string }[];
  history: ReviewAction[];
}

export function showPaper(store: ExperimentStore, paperId: string, version?: 'verified' | 'uncertain'): PaperReviewView {
  const preferred: 'verified' | 'uncertain' = version ?? (store.getUncertainPaper(paperId) ? 'uncertain' : 'verified');
  const record = store.getPaper(paperId, preferred);
  if (!record) throw new Error(`库中没有该论文：${paperId}${version ? `（${version} 版本）` : ''}`);
  const ref: RecordReference = { paper_id: record.paper.paper_id, version: preferred, revision: record.revision, verified_at: record.verified_at };
  return {
    paper: record.paper, record_ref: ref, revision: record.revision,
    verification_status: record.verification_status ?? 'verified',
    verified_by: record.verified_by, verified_at: record.verified_at,
    sources: record.sources.map(source => ({ id: source.id, path: source.path, kind: source.kind, page_count: source.page_count })),
    samples: record.draft.samples.map(sample => ({
      sample_id: sample.local_id, name: sample.name, material_state: sample.material_state, shared_from: sample.shared_from,
      phases: sample.phases.map(phase => ({ phase_id: phase.local_id, role: phase.role, formula: display(phase.formula), identity: display(phase.identity) })),
      materials: sample.materials.map(material => ({ material_id: material.local_id, identity: display(material.identity), amount: display(material.amount) })),
      steps: sample.steps.map(step => ({
        step_id: step.local_id, operation: display(step.operation),
        conditions: step.conditions.map(condition => ({
          name: condition.name, value: display(condition.fact), status: condition.fact.status,
          field_path: `samples.${sample.local_id}.steps.${step.local_id}.conditions.${condition.name}`,
        })),
      })),
    })),
    issues: record.verification.issues.map((issue, issue_index) => ({
      paper_id: record.paper.paper_id, title: record.paper.title, version: ref.version, record_ref: ref, issue_index,
      category: issueCategory(issue), category_label: CATEGORY_LABELS[issueCategory(issue)],
      issue_type: issue.issue_type, resolution_status: issue.resolution_status, action: issue.action ?? null,
      affects_matching: issue.affects_matching, sample_local_id: issue.sample_local_id, field_path: issue.field_path,
      current_value: issue.current_value, proposed_correction: issue.proposed_correction,
      evidence: issue.source_evidence, evidence_available: issue.source_evidence.length > 0,
      resolved_field: resolveField(record.draft, issue.field_path),
    })),
    missing_information: missingInformation(record).map(item => ({ sample_id: item.sample_id, field_path: item.field_path, message: item.message })),
    source_limitations: sourceLimitations(record).map(item => ({ sample_id: item.sample_id, field_path: item.field_path, message: item.message })),
    history: store.listReviewActions(paperId),
  };
}

/** Structure checks that can run from the stored record alone; quote text needs the PDF and is out of scope. */
export function structuralErrors(record: PublishedRecord): string[] {
  const errors: string[] = [];
  if (!Check(DraftSchema, record.draft)) errors.push('草稿不符合当前数据合同（DraftSchema）');
  if (!Check(VerificationSchema, record.verification)) errors.push('核验记录不符合当前数据合同（VerificationSchema）');
  const sourcePages = new Map(record.sources.map(source => [source.id, source.page_count]));
  const evidenceErrors = (fact: Fact, path: string) => {
    for (const ref of fact.evidence) {
      if (!sourcePages.has(ref.source_id)) errors.push(`${path}：证据来源 ${ref.source_id} 不在本记录来源清单中`);
      else if (ref.page < 1 || ref.page > sourcePages.get(ref.source_id)!) errors.push(`${path}：证据页码 ${ref.page} 超出 ${ref.source_id} 的页数`);
      if (!ref.quote.trim()) errors.push(`${path}：证据缺少引文`);
    }
  };
  const sampleIds = new Set<string>();
  for (const sample of record.draft.samples) {
    if (sampleIds.has(sample.local_id)) errors.push(`重复样品 ID：${sample.local_id}`);
    sampleIds.add(sample.local_id);
    for (const group of [sample.phases, sample.materials, sample.steps]) {
      if (new Set(group.map(item => item.local_id)).size !== group.length) errors.push(`样品 ${sample.local_id} 内存在重复 ID`);
    }
    for (const phase of sample.phases) {
      if (phase.metal_elements?.status === 'reported' && !derivePhaseMetalElements(phase, true)) errors.push(`相 ${phase.local_id} 的金属元素与化学式冲突`);
      evidenceErrors(phase.formula, `samples.${sample.local_id}.phases.${phase.local_id}.formula`);
      evidenceErrors(phase.identity, `samples.${sample.local_id}.phases.${phase.local_id}.identity`);
    }
    for (const material of sample.materials) {
      for (const key of ['identity', 'amount', 'concentration'] as const) evidenceErrors(material[key], `samples.${sample.local_id}.materials.${material.local_id}.${key}`);
    }
    for (const step of sample.steps) {
      evidenceErrors(step.operation, `samples.${sample.local_id}.steps.${step.local_id}.operation`);
      for (const condition of step.conditions) evidenceErrors(condition.fact, `samples.${sample.local_id}.steps.${step.local_id}.conditions.${condition.name}`);
    }
    evidenceErrors(sample.method, `samples.${sample.local_id}.method`);
    const materialIds = new Set(sample.materials.map(material => material.local_id));
    const inherited = new Map<string, number>();
    const visited = new Set([sample.local_id]);
    let parentId = sample.shared_from;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = record.draft.samples.find(candidate => candidate.local_id === parentId);
      if (!parent) break;
      for (const material of parent.materials) {
        materialIds.add(`${parent.local_id}.${material.local_id}`);
        inherited.set(material.local_id, (inherited.get(material.local_id) ?? 0) + 1);
      }
      parentId = parent.shared_from;
    }
    for (const [materialId, count] of inherited) if (count === 1) materialIds.add(materialId);
    for (const step of sample.steps) {
      if (step.material_refs.some(id => !materialIds.has(id))) errors.push(`步骤 ${step.local_id} 引用了不存在的原料`);
    }
  }
  for (const sample of record.draft.samples) {
    const visited = new Set([sample.local_id]);
    let parent = sample.shared_from;
    while (parent) {
      if (visited.has(parent)) { errors.push(`样品 ${sample.local_id} 的共用流程成环`); break; }
      visited.add(parent);
      const next = record.draft.samples.find(candidate => candidate.local_id === parent);
      if (!next) { errors.push(`不存在的共用样品：${parent}`); break; }
      parent = next.shared_from;
    }
  }
  for (const entry of [...record.match_entries, ...(record.candidate_match_entries ?? [])]) {
    const sample = record.draft.samples.find(candidate => candidate.local_id === entry.sample_local_id);
    if (!sample) errors.push(`匹配项引用了不存在的样品：${entry.sample_local_id}`);
    else if (!sample.phases.some(phase => phase.local_id === entry.phase_local_id)) errors.push(`匹配项引用了样品 ${sample.local_id} 中不存在的相：${entry.phase_local_id}`);
    if (entry.element_key !== entry.metal_elements.join('|')) errors.push(`匹配项元素键与金属集合不一致：${entry.sample_local_id}/${entry.phase_local_id}`);
  }
  return errors;
}

export interface ReviewDecision {
  action: ReviewActionKind;
  field_path?: string;
  issue_index?: number;
  reason?: string;
  value?: string | number | string[] | null;
  raw?: string | null;
  unit?: string | null;
  status?: Fact['status'];
  evidence?: Evidence[];
  note?: string;
}

export interface ReviewInput {
  paper_id: string;
  version?: 'verified' | 'uncertain';
  record_ref?: RecordReference;
  reviewer: string;
  reason?: string;
  confirm?: boolean;
  decisions: ReviewDecision[];
}

export interface ReviewResult {
  paper_id: string;
  previous: RecordReference;
  applied: boolean;
  published: RecordReference;
  verification_status: 'verified' | 'uncertain';
  actions: ReviewAction[];
  match_entries_rebuilt: boolean;
  structural_warnings: string[];
}

const factSnapshot = (fact: Fact | null) => fact ? { raw: fact.raw, value: fact.value, unit: fact.unit, status: fact.status, note: fact.note, evidence: fact.evidence } : null;

/**
 * Apply human decisions to a copy of the stored record, then publish one new revision
 * with the audit rows in the same transaction. The model's verification is never rewritten:
 * only the fields a person actually reviewed appear in `human_review.actions`.
 */
export function applyReview(store: ExperimentStore, input: ReviewInput, options: { bindCurrent?: boolean; now?: Date; dryRun?: boolean } = {}): ReviewResult {
  const reviewer = String(input.reviewer ?? '').trim();
  if (!reviewer) throw new Error('请提供审核人（--reviewer 或 JSON 中的 reviewer）');
  if (reviewer.length > 80) throw new Error('审核人名称过长');
  if (!Array.isArray(input.decisions) || !input.decisions.length) throw new Error('没有审核决定');
  if (input.decisions.length > 100) throw new Error('一次最多提交 100 条审核决定');
  const version: 'verified' | 'uncertain' = input.version ?? input.record_ref?.version ?? (store.getUncertainPaper(input.paper_id) ? 'uncertain' : 'verified');
  const original = store.getPaper(input.paper_id, version);
  if (!original) throw new Error(`库中没有该论文的 ${version} 版本：${input.paper_id}`);
  const expected = store.getPaperState(input.paper_id);
  const previous: RecordReference = { paper_id: original.paper.paper_id, version, revision: original.revision, verified_at: original.verified_at };
  if (input.record_ref) {
    if (input.record_ref.paper_id !== previous.paper_id || input.record_ref.version !== version ||
      input.record_ref.revision !== previous.revision || input.record_ref.verified_at !== previous.verified_at) {
      throw new Error('record_ref 与当前库内版本不一致，请重新读取后再提交；不会把决定应用到其他版本');
    }
  } else if (!options.bindCurrent) {
    throw new Error('请提供 record_ref（由 review show 输出）；若确认要绑定当前版本，显式加 --bind-current');
  }
  const now = (options.now ?? new Date()).toISOString();
  const record = structuredClone(original);
  // Revisions are monotonic across both stored versions, so a confirmed review never
  // collides with a newer record in the other table.
  const counterpart = store.getPaper(input.paper_id, version === 'uncertain' ? 'verified' : 'uncertain');
  const nextRevision = Math.max(original.revision, counterpart?.revision ?? 0) + 1;
  const actions: ReviewAction[] = [];
  const touchedFields = new Set<string>();
  let phaseCorrected = false;

  input.decisions.forEach((decision, index) => {
    const reason = String(decision.reason ?? input.reason ?? '').trim();
    if (!reason) throw new Error(`第 ${index + 1} 条决定缺少理由（reason）；审核记录必须可追溯`);
    if (!['confirm', 'correct', 'keep_conflict', 'request_repair'].includes(decision.action)) throw new Error(`第 ${index + 1} 条决定的 action 无效`);
    if (['confirm', 'correct'].includes(decision.action)) {
      const fieldPath = String(decision.field_path ?? '').trim();
      if (!fieldPath) throw new Error(`第 ${index + 1} 条决定缺少 field_path`);
      if (touchedFields.has(fieldPath)) throw new Error(`同一字段不能在一次提交中重复决定：${fieldPath}`);
      touchedFields.add(fieldPath);
      const resolved = resolveField(record.draft, fieldPath);
      if (!resolved) throw new Error(`字段不存在或不可直接编辑：${fieldPath}；请使用 review show 中的对象 ID 与字段名`);
      const before = factSnapshot(resolved.fact);
      if (decision.action === 'correct') {
        const fact = resolved.fact;
        if ([decision.value, decision.unit, decision.raw, decision.evidence, decision.note, decision.status].every(item => item === undefined)) {
          throw new Error(`correct 需要至少一项修改（value/unit/raw/evidence/note/status）：${fieldPath}`);
        }
        // A changed number must come with the source wording; otherwise the stored quote and value diverge.
        if (decision.value !== undefined && decision.raw === undefined && fact.raw) {
          const rendered = Array.isArray(decision.value) ? decision.value.join('、') : String(decision.value);
          if (!fact.raw.includes(rendered)) throw new Error(`修改数值时必须同时提供原文表述 raw：${fieldPath}；旧原文为「${fact.raw}」`);
        }
        if (decision.value !== undefined) fact.value = decision.value;
        if (decision.unit !== undefined) fact.unit = decision.unit;
        if (decision.status !== undefined) fact.status = decision.status;
        if (decision.raw !== undefined) fact.raw = decision.raw;
        if (decision.evidence !== undefined) fact.evidence = decision.evidence;
        if (decision.note !== undefined) fact.note = decision.note;
        if (fact.raw === null && fact.value !== null) {
          const rendered = Array.isArray(fact.value) ? fact.value.join('、') : String(fact.value);
          fact.raw = fact.unit ? `${rendered} ${fact.unit}` : rendered;
        }
        if (fact.status === 'reported') {
          if (fact.value === null) throw new Error(`reported 字段必须有值：${fieldPath}`);
          if (!fact.evidence.length) throw new Error(`改为 reported 时必须给出证据（source_id、page、quote）：${fieldPath}；没有引文请改标 ambiguous 或 not_reported`);
          if (!fact.raw) throw new Error(`reported 字段必须保留原文表述（raw）：${fieldPath}`);
        }
        if (!Check(FactSchema, fact)) throw new Error(`修改后的字段不符合数据合同：${fieldPath}`);
        if (/^phase_(formula|identity|metal_elements)$/.test(resolved.kind)) phaseCorrected = true;
      }
      actions.push({
        action_id: randomUUID(), paper_id: previous.paper_id, version, revision: nextRevision,
        reviewer, reviewed_at: now, action: decision.action, field_path: fieldPath, issue_index: null,
        reason, before, after: factSnapshot(resolved.fact), evidence: decision.evidence ?? null, record_ref: previous,
      });
      return;
    }
    const issueIndex = decision.issue_index;
    if (!Number.isInteger(issueIndex) || issueIndex! < 0 || issueIndex! >= record.verification.issues.length) {
      throw new Error(`第 ${index + 1} 条决定需要有效的 issue_index（0–${record.verification.issues.length - 1}）`);
    }
    const issue = record.verification.issues[issueIndex!];
    if (issue.resolution_status === 'resolved') throw new Error(`问题 #${issueIndex} 已标记解决，无需再次处理`);
    if (decision.action === 'keep_conflict') {
      if (issue.resolution_status === 'confirmed_error' || issue.action === 'repair') {
        throw new Error(`问题 #${issueIndex} 是已确认的抽取错误，不能改标为原文冲突；请用 correct 修正字段，或 request_repair 请求模型修正`);
      }
      issue.action = 'source_limit';
      issue.resolution_status = 'unresolved';
    } else {
      issue.action = 'repair';
      if (issue.resolution_status !== 'confirmed_error') issue.resolution_status = 'unresolved';
    }
    actions.push({
      action_id: randomUUID(), paper_id: previous.paper_id, version, revision: nextRevision,
      reviewer, reviewed_at: now, action: decision.action, field_path: issue.field_path, issue_index: issueIndex!,
      reason, before: { issue_type: issue.issue_type, resolution_status: issue.resolution_status, action: issue.action },
      after: { issue_type: issue.issue_type, resolution_status: issue.resolution_status, action: issue.action },
      evidence: issue.source_evidence.length ? issue.source_evidence : null, record_ref: previous,
    });
  });

  let rebuilt = false;
  if (phaseCorrected && record.verification.source_identity === 'confirmed') {
    record.match_entries = matchingEntries(record.draft, record.verification);
    record.candidate_match_entries = matchingEntries(record.draft, record.verification, true)
      .filter(entry => !record.match_entries.some(match => match.sample_local_id === entry.sample_local_id && match.phase_local_id === entry.phase_local_id));
    rebuilt = true;
  }

  const remaining = record.verification.issues.filter(isExtractionIssue);
  if (input.confirm && remaining.length) {
    throw new Error(`仍有 ${remaining.length} 条未解决的抽取问题，不能整篇确认为已核验：${remaining.slice(0, 3).map(issueText).join('；')}`);
  }
  record.verification_status = input.confirm ? 'verified' : (original.verification_status ?? version);
  const human: HumanReview = {
    reviewer, reviewed_at: now, previous_revision: original.revision, previous_verified_at: original.verified_at,
    actions: actions.map(action => ({ action: action.action, field_path: action.field_path, reason: action.reason })),
  };
  record.human_review = human;
  record.revision = nextRevision;
  record.verified_at = now;

  const errors = structuralErrors(record);
  if (errors.length) throw new Error(`发布前结构校验未通过：${errors.slice(0, 5).join('；')}`);
  if (!options.dryRun) store.publishReview(record, expected, actions);
  return {
    paper_id: previous.paper_id, previous, applied: !options.dryRun,
    published: { paper_id: previous.paper_id, version: record.verification_status === 'uncertain' ? 'uncertain' : 'verified', revision: record.revision, verified_at: record.verified_at },
    verification_status: record.verification_status === 'uncertain' ? 'uncertain' : 'verified',
    actions, match_entries_rebuilt: rebuilt,
    structural_warnings: record.verification.source_identity === 'confirmed' ? [] : ['来源身份未确认，金属匹配索引未重建'],
  };
}

/** Pending model repairs requested by a reviewer, ready to be fed to repair_uncertain_paper. */
export function pendingRepairs(store: ExperimentStore, paperId?: string): { paper_id: string; version: string; issue_index: number; field_path: string; reason: string; reviewer: string; reviewed_at: string }[] {
  const actions = store.listReviewActions(paperId).filter(action => action.action === 'request_repair');
  const latest = new Map<string, ReviewAction>();
  for (const action of actions) latest.set(`${action.paper_id}|${action.issue_index}`, action);
  return [...latest.values()].map(action => ({
    paper_id: action.paper_id, version: action.version, issue_index: action.issue_index ?? -1,
    field_path: action.field_path, reason: action.reason, reviewer: action.reviewer, reviewed_at: action.reviewed_at,
  }));
}

/** Chain helper used by the CLI to print the sample tree next to an issue. */
export function issueSampleChain(draft: Draft, sampleId: string | null): string[] {
  if (!sampleId) return [];
  try { return preparationChain(draft, sampleId).map(sample => sample.local_id); }
  catch { return []; }
}
