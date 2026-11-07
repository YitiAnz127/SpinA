import { Check } from 'typebox/value';
import { EvidenceSchema } from '../distillation/schema.ts';
import type { Evidence } from '../distillation/schema.ts';
import { CLAIM_KINDS, CLAIM_RELATION_TYPES, type ClaimKind, type ClaimRelationType, type ClaimSupportRef, type ResearchStore, type ScientificClaim } from './store.ts';
import { newId, normalizeSubjectRef, nowIso, type SubjectRef } from './contracts.ts';

/**
 * F3: scientific claims and disagreement.
 *
 * A claim is an object with a subject, a scope, support and assumptions. Author observations,
 * author interpretations and system hypotheses stay distinguishable; `cites` is a relation,
 * never a second independent support.
 */

export const CLAIM_KIND_LABELS: Record<ClaimKind, string> = {
  author_observation: '作者观察',
  author_interpretation: '作者解释',
  computed_result: '计算结果',
  system_hypothesis: '系统假设',
};

export const CLAIM_RELATION_LABELS: Record<ClaimRelationType, string> = {
  supports: '支持',
  contradicts: '相反',
  depends_on: '依赖',
  alternative_to: '替代解释',
  cites: '引用',
};

export interface ClaimInput {
  claim_id?: string;
  paper_id: string;
  topic: string;
  statement: string;
  kind: ClaimKind;
  stance?: 'positive' | 'negative' | 'neutral';
  subject_refs: SubjectRef[];
  scope?: { composition?: string; treatment?: string; measurement?: string };
  support_refs?: ClaimSupportRef[];
  assumptions?: string[];
  counter_refs?: ClaimSupportRef[];
  origin_family?: string;
  relations?: { type: ClaimRelationType; target_claim_id: string }[];
  evidence?: Evidence[];
}

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];

function normalizeSupport(ref: ClaimSupportRef, label: string): ClaimSupportRef {
  if (!ref || !['observation', 'claim', 'evidence'].includes(ref.kind)) throw new Error(`${label}.kind 必须为 observation、claim 或 evidence`);
  const out: ClaimSupportRef = { kind: ref.kind };
  for (const key of ['id', 'paper_id', 'sample_id', 'field_path', 'quote'] as const) {
    if (ref[key] !== undefined && ref[key] !== null) out[key] = String(ref[key]);
  }
  return out;
}

export function validateClaim(input: ClaimInput): ScientificClaim {
  if (!input || typeof input !== 'object') throw new Error('claim 必须是对象');
  const paperId = text(input.paper_id, 'paper_id');
  const topic = text(input.topic, 'topic').normalize('NFKC').toLowerCase();
  const statement = text(input.statement, 'statement');
  if (!CLAIM_KINDS.includes(input.kind)) throw new Error(`claim.kind 必须为 ${CLAIM_KINDS.join('、')}`);
  const stance = input.stance ?? 'neutral';
  if (!['positive', 'negative', 'neutral'].includes(stance)) throw new Error('claim.stance 必须为 positive、negative 或 neutral');
  const subjectRefs = (input.subject_refs ?? []).map(normalizeSubjectRef);
  if (!subjectRefs.length) throw new Error('claim 需要至少一个 subject_ref');
  const supportRefs = (input.support_refs ?? []).map((ref, index) => normalizeSupport(ref, `support_refs[${index}]`));
  const counterRefs = (input.counter_refs ?? []).map((ref, index) => normalizeSupport(ref, `counter_refs[${index}]`));
  if (input.kind === 'author_observation' && !supportRefs.some(ref => ref.kind === 'observation' || ref.kind === 'evidence')) {
    throw new Error('作者观察类论断必须有直接观察或证据支撑；只有解释时请标为 author_interpretation');
  }
  const relations = (input.relations ?? []).map((relation, index) => {
    if (!CLAIM_RELATION_TYPES.includes(relation.type)) throw new Error(`relations[${index}].type 必须为 ${CLAIM_RELATION_TYPES.join('、')}`);
    return { type: relation.type, target_claim_id: text(relation.target_claim_id, `relations[${index}].target_claim_id`) };
  });
  const evidence = input.evidence ?? [];
  for (const [index, item] of evidence.entries()) {
    if (!Check(EvidenceSchema, item)) throw new Error(`evidence[${index}] 结构无效：需要 source_id、page、quote`);
  }
  const originFamily = input.origin_family?.trim()
    || (input.kind === 'system_hypothesis' ? `system:${newId('origin')}` : `paper:${paperId}`);
  if (input.kind === 'system_hypothesis' && !originFamily.startsWith('system:')) {
    throw new Error('系统假设的 origin_family 必须以 system: 开头，避免被当作原文来源');
  }
  return {
    claim_id: input.claim_id?.trim() || newId('claim'),
    paper_id: paperId, topic, statement, kind: input.kind, stance,
    subject_refs: subjectRefs,
    scope: {
      ...(input.scope?.composition ? { composition: input.scope.composition } : {}),
      ...(input.scope?.treatment ? { treatment: input.scope.treatment } : {}),
      ...(input.scope?.measurement ? { measurement: input.scope.measurement } : {}),
    },
    support_refs: supportRefs, assumptions: strings(input.assumptions), counter_refs: counterRefs,
    origin_family: originFamily, relations, evidence, created_at: nowIso(),
  };
}

export function ingestClaims(store: ResearchStore, inputs: ClaimInput[]): ScientificClaim[] {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('没有要登记的论断');
  const claims = inputs.map(validateClaim);
  const ids = new Set(claims.map(claim => claim.claim_id));
  if (ids.size !== claims.length) throw new Error('claim_id 重复');
  for (const claim of claims) store.addClaim(claim);
  return claims;
}

const normalize = (value: string | undefined) => (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
// A controlled material label aligns claims across papers; without it, alignment falls back to the sample.
const subjectKeyOf = (ref: SubjectRef) => ref.material
  ? `material:${normalize(ref.material)}`
  : `${ref.paper_id}::${ref.sample_id ?? ''}`;
const subjectSet = (claim: ScientificClaim) => new Set(claim.subject_refs.map(subjectKeyOf));

export interface DisagreementPair {
  a: string;
  b: string;
  classification: 'true_conflict' | 'scope_mismatch' | 'subject_mismatch' | 'evidence_level_mismatch' | 'citation_not_independent' | 'no_conflict';
  aligned: string[];
  misaligned: string[];
  explanation: string;
  unresolved: string[];
}

export interface TopicAnalysis {
  topic: string;
  claims: { claim_id: string; paper_id: string; kind: ClaimKind; stance: string; statement: string }[];
  pairs: DisagreementPair[];
  independent_support: { claim_id: string; origins: string[]; count: number; note: string }[];
}

export interface ClaimGraphData {
  topics: TopicAnalysis[];
  unresolved: string[];
  provenance: 'deterministic_analysis';
}

function classify(a: ScientificClaim, b: ScientificClaim): DisagreementPair {
  const aligned: string[] = [];
  const misaligned: string[] = [];
  const unresolved: string[] = [];
  const subjectsA = subjectSet(a), subjectsB = subjectSet(b);
  const sameSubject = subjectsA.size === subjectsB.size && [...subjectsA].every(key => subjectsB.has(key));
  if (sameSubject) aligned.push('主体：同一材料或同一样品集合');
  else misaligned.push(`主体：${[...subjectsA].join('、')} vs ${[...subjectsB].join('、')}`);

  const scopeKeys = ['composition', 'treatment', 'measurement'] as const;
  const scopeDiff: string[] = [];
  for (const key of scopeKeys) {
    const left = normalize(a.scope[key]), right = normalize(b.scope[key]);
    if (left && right && left === right) aligned.push(`范围：${key} 一致`);
    else if (left !== right) { scopeDiff.push(key); misaligned.push(`范围：${key} 未对齐（${a.scope[key] ?? '未记录'} vs ${b.scope[key] ?? '未记录'}）`); }
  }

  const cites = a.relations.some(relation => relation.type === 'cites' && relation.target_claim_id === b.claim_id)
    || b.relations.some(relation => relation.type === 'cites' && relation.target_claim_id === a.claim_id);
  const contradicts = a.relations.some(relation => relation.type === 'contradicts' && relation.target_claim_id === b.claim_id)
    || b.relations.some(relation => relation.type === 'contradicts' && relation.target_claim_id === a.claim_id);
  const opposite = (a.stance === 'positive' && b.stance === 'negative') || (a.stance === 'negative' && b.stance === 'positive');
  const sameOrigin = a.origin_family === b.origin_family;

  const base = { a: a.claim_id, b: b.claim_id, aligned, misaligned, unresolved };
  if (cites && !contradicts && !opposite) {
    return { ...base, classification: 'citation_not_independent',
      explanation: '一方引用另一方，属于同一来源的转述，不构成第二份独立支持，也不是真正分歧。' };
  }
  if (a.kind !== b.kind) {
    return { ...base, classification: 'evidence_level_mismatch',
      explanation: `证据层次不同（${CLAIM_KIND_LABELS[a.kind]} vs ${CLAIM_KIND_LABELS[b.kind]}）；一个是直接观察，另一个是解释或假设，不能按相反结论处理。` };
  }
  if (scopeDiff.length) {
    return { ...base, classification: 'scope_mismatch',
      explanation: `结论适用范围未对齐（${scopeDiff.join('、')}）；在补齐这些条件前，不能判定为真正冲突。` };
  }
  if (!sameSubject) {
    return { ...base, classification: 'subject_mismatch',
      explanation: '讨论的不是同一材料/样品状态；可能只是对象不同，而非解释冲突。' };
  }
  if (opposite || contradicts) {
    return { ...base, classification: 'true_conflict',
      explanation: sameOrigin
        ? '同一来源内部出现相反立场；这是原文自身分歧，不是两项独立研究之间的矛盾。'
        : '主体与范围已对齐，但立场相反；这是需要解释的真正分歧。' };
  }
  if (sameOrigin) {
    return { ...base, classification: 'no_conflict',
      explanation: '同一来源的论断，立场不矛盾；不能按篇数累加为独立支持。' };
  }
  return { ...base, classification: 'no_conflict', explanation: '主体、范围与立场均未发现矛盾。' };
}

/**
 * Align subjects and scope before calling anything a disagreement. Support is counted by
 * unique origin family, and citations never add an independent origin.
 */
export function explainDisagreement(claims: ScientificClaim[]): ClaimGraphData {
  const unresolved: string[] = [];
  const topics = new Map<string, ScientificClaim[]>();
  for (const claim of claims) {
    if (!claim.topic) { unresolved.push(`论断 ${claim.claim_id} 没有 topic，无法配对`); continue; }
    const list = topics.get(claim.topic) ?? [];
    list.push(claim);
    topics.set(claim.topic, list);
  }
  const byId = new Map(claims.map(claim => [claim.claim_id, claim]));
  for (const claim of claims) {
    for (const relation of claim.relations) {
      if (!byId.has(relation.target_claim_id)) unresolved.push(`论断 ${claim.claim_id} 的关系指向不存在的 ${relation.target_claim_id}`);
    }
  }

  const analyses: TopicAnalysis[] = [...topics.entries()].map(([topic, group]) => {
    const pairs: DisagreementPair[] = [];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) pairs.push(classify(group[i], group[j]));
    }
    const independent = group.map(claim => {
      const origins = new Set<string>();
      const hasOwnEvidence = claim.support_refs.some(ref => ref.kind === 'observation' || ref.kind === 'evidence');
      if (hasOwnEvidence) origins.add(claim.origin_family);
      for (const other of claims) {
        if (other.claim_id === claim.claim_id || other.kind === 'system_hypothesis') continue;
        const supports = other.relations.some(relation => relation.type === 'supports' && relation.target_claim_id === claim.claim_id);
        if (supports) origins.add(other.origin_family);
      }
      return {
        claim_id: claim.claim_id, origins: [...origins].sort(), count: origins.size,
        note: origins.size === 0 ? '没有独立来源支撑；仅为解释或假设' : origins.size === 1 ? '只有一个来源家族，不能按篇数累加' : '存在多个独立来源家族',
      };
    });
    return {
      topic,
      claims: group.map(claim => ({ claim_id: claim.claim_id, paper_id: claim.paper_id, kind: claim.kind, stance: claim.stance, statement: claim.statement })),
      pairs, independent_support: independent,
    };
  });
  analyses.sort((a, b) => a.topic.localeCompare(b.topic));
  return { topics: analyses, unresolved: [...new Set(unresolved)], provenance: 'deterministic_analysis' };
}
