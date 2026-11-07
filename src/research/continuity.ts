import type { PublishedRecord, RecordReference } from '../distillation/store.ts';
import type { Observation, ResearchStore, SpecimenRelation } from './store.ts';
import { checkContinuity, fingerprintDraft, type ContinuityCheck, type SampleFingerprint } from './specimen-identity.ts';

/**
 * Cross-revision evidence binding.
 *
 * An observation keeps the revision it was read from plus the chemistry fingerprint of its
 * sample. After a re-distillation the revision alone says "stale"; the fingerprint says why:
 * the same sample survived, the ID moved, the ID now points at another material, or the
 * sample is gone. Only `same_specimen` may reuse the old value without re-reading the paper.
 */

export interface ObservationContinuity extends ContinuityCheck {
  observation_id: string;
  sample_id: string;
  metric: string;
  record_ref: RecordReference | null;
  /** True only when the stored revision is the current one. */
  revision_current: boolean;
}

export interface RelationContinuity {
  relation_id: string;
  relation: SpecimenRelation['relation'];
  from: { specimen_id: string } & ContinuityCheck;
  to: { specimen_id: string } & ContinuityCheck;
  record_ref: RecordReference | null;
  revision_current: boolean;
  /** Both endpoints resolve to the same specimen, so the edge can be carried forward. */
  reusable: boolean;
}

export interface ContinuityReport {
  paper_id: string;
  current: RecordReference;
  observations: ObservationContinuity[];
  relations: RelationContinuity[];
  summary: {
    observations: Record<string, number>;
    relations: Record<string, number>;
    /** Observations that may be reused as-is. */
    reusable_observations: number;
    /** Observations whose sample survived but whose revision changed: re-read the paper. */
    needs_revalidation: number;
    /** Observations that no longer map to a sample. */
    orphaned: number;
  };
  unresolved: string[];
  semantics: string;
}

const bump = (target: Record<string, number>, key: string) => { target[key] = (target[key] ?? 0) + 1; };

const sameRevision = (ref: RecordReference | null, current: RecordReference) =>
  Boolean(ref) && ref!.version === current.version && ref!.revision === current.revision && ref!.verified_at === current.verified_at;

const sampleOf = (specimenId: string) => {
  const at = specimenId.indexOf('::');
  return at >= 0 ? specimenId.slice(at + 2) : specimenId;
};

export function checkEvidenceContinuity(
  record: PublishedRecord,
  version: RecordReference['version'],
  store: ResearchStore,
): ContinuityReport {
  const current: RecordReference = {
    paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at,
  };
  const fingerprints = fingerprintDraft(record.draft);
  const byId = new Map<string, SampleFingerprint>(fingerprints.map(item => [item.sample_id, item]));
  const unresolved: string[] = [];

  const observations = store.listObservations(record.paper.paper_id).map(observation => {
    const revisionCurrent = sameRevision(observation.record_ref ?? null, current);
    // A current observation needs no fingerprint: its sample is by definition the one it names.
    const check = revisionCurrent
      ? { status: 'current' as const, resolved_sample_id: observation.sample_id, explanation: '观察绑定当前修订' }
      : checkContinuity(observation.sample_fingerprint ?? byId.get(observation.sample_id) ?? null, fingerprints, observation.sample_id);
    if (!revisionCurrent && !observation.sample_fingerprint) {
      unresolved.push(`观察 ${observation.observation_id} 没有化学指纹：只能按样品 ID 判断，不能确认是否为同一实验样品`);
    }
    return {
      observation_id: observation.observation_id, sample_id: observation.sample_id,
      metric: observation.metric, record_ref: observation.record_ref ?? null,
      revision_current: revisionCurrent, ...check,
    } satisfies ObservationContinuity;
  });

  const relations = store.listSpecimenRelations(record.paper.paper_id).map(relation => {
    const revisionCurrent = sameRevision(relation.record_ref ?? null, current);
    const endpoint = (specimenId: string, stored: SampleFingerprint | null | undefined) => {
      const sampleId = sampleOf(specimenId);
      const check = revisionCurrent
        ? { status: 'current' as const, resolved_sample_id: sampleId, explanation: '关系绑定当前修订' }
        : checkContinuity(stored ?? byId.get(sampleId) ?? null, fingerprints, sampleId);
      return { specimen_id: specimenId, ...check };
    };
    const from = endpoint(relation.from_specimen, relation.fingerprints?.from);
    const to = endpoint(relation.to_specimen, relation.fingerprints?.to);
    if (!revisionCurrent && !relation.fingerprints) {
      unresolved.push(`关系 ${relation.relation_id} 没有端点指纹：只能按样品 ID 判断`);
    }
    return {
      relation_id: relation.relation_id, relation: relation.relation, from, to,
      record_ref: relation.record_ref ?? null, revision_current: revisionCurrent,
      // A moved endpoint is still reusable when the chemistry matched uniquely; a redefined or
      // missing endpoint is not, because the edge may now connect different materials.
      reusable: [from.status, to.status].every(status => status === 'current' || status === 'same_specimen' || status === 'relabelled'),
    } satisfies RelationContinuity;
  });

  const observationCounts: Record<string, number> = {};
  for (const item of observations) bump(observationCounts, item.status);
  const relationCounts: Record<string, number> = {};
  for (const item of relations) bump(relationCounts, item.reusable ? (item.revision_current ? 'current' : 'reusable') : 'blocked');

  const countBy = (...statuses: string[]) => observations.filter(item => statuses.includes(item.status)).length;
  // Reuse means "nothing changed since it was read". A surviving sample under a new revision is
  // good news but still requires re-reading the paper's numbers before the value is trusted.
  const reusableObservations = countBy('current');
  const needsRevalidation = countBy('same_specimen', 'relabelled');
  const orphaned = countBy('redefined', 'missing', 'unverifiable');

  return {
    paper_id: record.paper.paper_id, current, observations, relations,
    summary: {
      observations: observationCounts, relations: relationCounts,
      reusable_observations: reusableObservations,
      needs_revalidation: needsRevalidation,
      orphaned,
    },
    unresolved: [...new Set(unresolved)],
    semantics: 'same_specimen 表示样品 ID 与目标相化学指纹均未变，但修订变化后仍需复核原文数值；relabelled 表示样品换了 ID 而化学指纹一致，须人工确认是否同一批样品；redefined 表示 ID 未变而化学指纹变化，旧观察不能沿用；missing 表示无法定位样品。指纹只证明记录一致，不证明是同一物理批次。',
  };
}
