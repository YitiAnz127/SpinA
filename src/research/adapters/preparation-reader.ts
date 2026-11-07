import type { ExperimentStore, PublishedRecord, RecordReference } from '../../distillation/store.ts';

/**
 * Adapter between the preparation knowledge core and the research layer.
 *
 * The research layer never re-implements record reading: it uses the same version-bound
 * access as the existing tools, so a research artifact cannot silently read a newer revision.
 */

export interface ResolvedSample {
  record: PublishedRecord;
  version: RecordReference['version'];
  ref: RecordReference;
  sampleId: string | null;
}

export function recordRef(record: PublishedRecord, version: RecordReference['version']): RecordReference {
  return { paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at };
}

/**
 * Bind to the version that actually contains the requested sample. A paper can exist in both
 * tables; picking the wrong one would make a valid sample look missing.
 */
export function resolveSample(store: ExperimentStore, paperId: string, sampleId?: string, version?: RecordReference['version']): ResolvedSample {
  const candidates = version ? [version] : (['verified', 'uncertain'] as const);
  for (const candidate of candidates) {
    const record = store.getPaper(paperId, candidate);
    if (!record) continue;
    if (!sampleId) return { record, version: candidate, ref: recordRef(record, candidate), sampleId: null };
    if (record.draft.samples.some(sample => sample.local_id === sampleId)) {
      return { record, version: candidate, ref: recordRef(record, candidate), sampleId };
    }
  }
  const available = [...new Set(candidates.flatMap(candidate => (store.getPaper(paperId, candidate)?.draft.samples ?? []).map(sample => sample.local_id)))];
  if (!available.length) throw new Error(`库中没有该论文：${paperId}`);
  throw new Error(`所选版本中不存在样品：${sampleId}；可用样品：${available.slice(0, 20).join('、')}${available.length > 20 ? ' …' : ''}`);
}

export function targetSamples(record: PublishedRecord): PublishedRecord['draft']['samples'] {
  return record.draft.samples.filter(sample => sample.phases.some(phase => phase.role === 'target_spinel'));
}
