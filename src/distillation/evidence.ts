import { preparationVariables, type Draft, type Fact } from './schema.ts';
import { ExperimentStore, type RecordReference } from './store.ts';
import { preparationChain } from './preparation.ts';

/** Literal paths use object IDs/names, never array offsets or executable property access. */
export function preparationFields(sample: Draft['samples'][number]) {
  const prefix = `samples.${sample.local_id}`;
  const fields: { field_path: string; fact: Fact; context?: Record<string, unknown> }[] = [];
  const add = (path: string, fact: Fact | undefined, context?: Record<string, unknown>) => {
    if (fact) fields.push({ field_path: `${prefix}.${path}`, fact, ...(context ? { context } : {}) });
  };
  add('method', sample.method);
  for (const variable of preparationVariables(sample)) add(`variables.${variable.name}`, variable.fact);
  for (const material of sample.materials) {
    const context = { material_id: material.local_id, identity: material.identity };
    for (const key of ['identity', 'amount', 'concentration'] as const) add(`materials.${material.local_id}.${key}`, material[key], context);
  }
  for (const phase of sample.phases) {
    for (const key of ['formula', 'identity', 'metal_elements'] as const) add(`phases.${phase.local_id}.${key}`, phase[key], { phase_id: phase.local_id, role: phase.role });
  }
  for (const step of sample.steps) {
    const context = { step_id: step.local_id, operation: step.operation, description: step.description };
    add(`steps.${step.local_id}.operation`, step.operation, context);
    add(`steps.${step.local_id}.description`, step.description, context);
    for (const condition of step.conditions) add(`steps.${step.local_id}.conditions.${condition.name}`, condition.fact, context);
  }
  return fields;
}

/** Read saved evidence only; no source files, page images, models or writes are involved. */
export async function readPreparationEvidence(root: string, reference: RecordReference, sampleId: string, fieldPath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const store = await ExperimentStore.openExisting(root);
  if (!store) throw new Error('检索版本不可用，请重新检索后反查');
  try {
    const record = store.getReferencedPaper(reference);
    const chain = preparationChain(record.draft, sampleId, signal);
    const matches = chain.flatMap(sample => preparationFields(sample)
      .filter(field => field.field_path === fieldPath).map(field => ({ ...field, source_sample_id: sample.local_id })));
    if (!matches.length) throw new Error('所选样品及其共用祖先中不存在该字段；请使用流程工具中的对象 ID 和字段名，不使用数组下标或其他分支字段');
    const scope = new Set(chain.map(sample => sample.local_id));
    const related = (path: string) => path === fieldPath || path.startsWith(`${fieldPath}.`) || fieldPath.startsWith(`${path}.`);
    return {
      paper: record.paper, record_ref: { ...reference }, sample_id: sampleId,
      field_path: fieldPath, ambiguous: matches.length > 1,
      evidence_scope: 'stored_record' as const,
      fields: matches.map(({ source_sample_id, fact, context }) => ({
        source_sample_id,
        has_recorded_content: fact.raw !== null || fact.value !== null || Boolean(fact.note.trim()) || fact.evidence.length > 0 || fact.status !== 'not_reported',
        fact, ...(context ? { context } : {}),
      })),
      sources: [...new Set(matches.flatMap(match => match.fact.evidence.map(ref => ref.source_id)))].map(id => {
        const source = record.sources.find(source => source.id === id);
        return source ? { id, kind: source.kind, path: source.path } : { id, missing_metadata: true };
      }),
      context: {
        samples: chain.map(sample => ({ sample_id: sample.local_id, name: sample.name, shared_from: sample.shared_from,
          variables: preparationVariables(sample), notes: sample.unresolved_questions })),
        paper_notes: record.draft.notes,
      },
      issues: record.verification.issues.filter(issue => issue.resolution_status !== 'resolved' &&
        (issue.sample_local_id === null || scope.has(issue.sample_local_id)) && related(issue.field_path)),
    };
  } finally { store.close(); }
}
