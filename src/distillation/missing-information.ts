import { preparationVariables, type Draft, type Fact, type Verification } from './schema.ts';

type Issue = Verification['issues'][number];
export interface MissingInformation {
  sample_id: string | null;
  field_path: string;
  status: 'not_reported' | 'source_missing' | 'source_limit';
  message: string;
}
type RecordInput = { draft: Draft; verification?: Verification };
export const issueText = (issue: Issue) => `${issue.field_path}: ${issue.proposed_correction || issue.current_value}`;

// Source limitations describe the paper; extraction issues describe our record.
// A confirmed extraction error cannot be reclassified by a source_limit action.
export const isSourceLimitationIssue = (issue: Issue) =>
  issue.resolution_status === 'unresolved' && issue.action === 'source_limit';
export const isExtractionIssue = (issue: Issue) =>
  issue.resolution_status === 'confirmed_error' ||
  (issue.resolution_status === 'unresolved' && issue.action === 'repair');
export const isMissingInformationIssue = (issue: Issue) =>
  isSourceLimitationIssue(issue) &&
  ['omission', 'step_omission', 'source_error'].includes(issue.issue_type);

export function missingInformation(record: RecordInput, sampleIds?: Set<string>): MissingInformation[] {
  const gaps: MissingInformation[] = (record.verification?.issues ?? [])
    .filter(isMissingInformationIssue)
    .filter(issue => !sampleIds || issue.sample_local_id === null || sampleIds.has(issue.sample_local_id))
    .map(issue => ({ sample_id: issue.sample_local_id, field_path: issue.field_path,
      status: 'source_limit', message: issue.proposed_correction || issue.current_value }));
  for (const sample of record.draft.samples) {
    if (sampleIds && !sampleIds.has(sample.local_id)) continue;
    const add = (path: string, fact: Fact, explicit = false) => {
      if (fact.status !== 'not_reported' && fact.status !== 'source_missing') return;
      // Empty optional facts are parser defaults, not evidence of a critical gap.
      if (!explicit && fact.status === 'not_reported' && !fact.note.trim()) return;
      gaps.push({ sample_id: sample.local_id, field_path: `samples.${sample.local_id}.${path}`,
        status: fact.status, message: fact.note || (fact.status === 'source_missing' ? '所需来源未取得' : '原文未报告此项') });
    };
    add('method', sample.method);
    for (const material of sample.materials) {
      add(`materials.${material.local_id}.identity`, material.identity);
      add(`materials.${material.local_id}.amount`, material.amount);
      add(`materials.${material.local_id}.concentration`, material.concentration);
    }
    for (const variable of preparationVariables(sample)) add(`variables.${variable.name}`, variable.fact, true);
    for (const step of sample.steps) {
      add(`steps.${step.local_id}.operation`, step.operation);
      for (const condition of step.conditions) add(`steps.${step.local_id}.conditions.${condition.name}`, condition.fact, true);
    }
  }
  return [...new Map(gaps.map(gap => [JSON.stringify(gap), gap])).values()];
}

export function sourceLimitations(record: RecordInput, sampleIds?: Set<string>): MissingInformation[] {
  return (record.verification?.issues ?? [])
    .filter(issue => isSourceLimitationIssue(issue) && !isMissingInformationIssue(issue))
    .filter(issue => !sampleIds || issue.sample_local_id === null || sampleIds.has(issue.sample_local_id))
    .map(issue => ({ sample_id: issue.sample_local_id, field_path: issue.field_path,
      status: 'source_limit', message: issue.proposed_correction || issue.current_value }));
}

export function sourceInformationMessages(record: RecordInput, sampleIds?: Set<string>): Set<string> {
  const messages = new Set([...missingInformation(record, sampleIds), ...sourceLimitations(record, sampleIds)].map(gap => gap.message));
  for (const issue of record.verification?.issues ?? []) {
    if (isSourceLimitationIssue(issue) && (!sampleIds || issue.sample_local_id === null || sampleIds.has(issue.sample_local_id))) messages.add(issueText(issue));
  }
  return messages;
}
