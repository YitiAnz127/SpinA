import { compactDraft, type Draft } from './schema.ts';
import { ExperimentStore, type RecordReference } from './store.ts';
import { isExtractionIssue, issueText, missingInformation, sourceLimitations } from './missing-information.ts';

export function preparationChain(draft: Draft, sampleId: string, signal?: AbortSignal): Draft['samples'] {
  const samples = new Map(draft.samples.map(sample => [sample.local_id, sample]));
  if (samples.size !== draft.samples.length) throw new Error('记录包含重复样品 ID，无法确定共用流程');
  let current = samples.get(sampleId);
  if (!current) throw new Error(`所选版本中不存在样品：${sampleId}`);
  const chain: Draft['samples'] = [], seen = new Set<string>();
  while (current) {
    signal?.throwIfAborted();
    if (seen.has(current.local_id)) throw new Error(`共用流程存在循环引用：${current.local_id}`);
    seen.add(current.local_id); chain.push(current);
    if (!current.shared_from) break;
    const parent = samples.get(current.shared_from);
    if (!parent) throw new Error(`样品 ${current.local_id} 的共用流程不存在：${current.shared_from}`);
    current = parent;
  }
  return chain.reverse();
}

/** Read the selected sample and its explicit shared procedures without merging their facts. */
export async function readSamplePreparation(root: string, reference: RecordReference, sampleId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const store = await ExperimentStore.openExisting(root);
  if (!store) throw new Error('检索版本不可用，请重新检索后展开');
  try {
    const record = store.getReferencedPaper(reference);
    const chain = preparationChain(record.draft, sampleId, signal);
    const scope = new Set(chain.map(sample => sample.local_id));
    return {
      paper: record.paper,
      record_ref: { ...reference },
      sample_id: sampleId,
      sources: record.sources.map(source => ({ id: source.id, path: source.path, kind: source.kind })),
      // Keep IDs, step order, short evidence and explicit unknowns. Paper-level notes may restrict inheritance.
      preparation: compactDraft({ ...record.draft, samples: chain }),
      match_entries: record.match_entries.filter(entry => entry.sample_local_id === sampleId),
      candidate_match_entries: (record.candidate_match_entries ?? []).filter(entry => entry.sample_local_id === sampleId),
      missing_information: missingInformation(record, scope),
      source_limitations: sourceLimitations(record, scope),
      issues: record.verification.issues
        .filter(issue => isExtractionIssue(issue) && (issue.sample_local_id === null || scope.has(issue.sample_local_id)))
        .map(issue => ({ sample_id: issue.sample_local_id, field_path: issue.field_path,
          status: issue.resolution_status, message: issueText(issue) })),
    };
  } finally { store.close(); }
}
