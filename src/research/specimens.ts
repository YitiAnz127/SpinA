import { preparationChain } from '../distillation/preparation.ts';
import type { PublishedRecord, RecordReference } from '../distillation/store.ts';
import type { Evidence } from '../distillation/schema.ts';
import { resolveMaterialIdentity, type MaterialIdentity } from './materials.ts';
import type { Observation, ResearchStore, SpecimenRelationType } from './store.ts';

/**
 * F4: specimen state and lineage.
 *
 * `shared_from` is preparation inheritance, not a physical transformation. Only explicitly
 * recorded relations become aliquot/deposition/post-treatment/test-state edges; nothing is
 * inferred from similar sample names.
 */

export const specimenId = (paperId: string, sampleId: string) => `${paperId}::${sampleId}`;

export type SpecimenEdgeRelation = 'preparation_inherits' | SpecimenRelationType;

export interface SpecimenNode {
  specimen_id: string;
  paper_id: string;
  sample_id: string;
  name: string;
  material_state: string;
  shared_from: string | null;
  identity: MaterialIdentity | null;
  external: boolean;
}

export interface SpecimenEdge {
  from: string;
  to: string;
  relation: SpecimenEdgeRelation;
  basis: 'record_shared_from' | 'explicit_relation';
  evidence: Evidence[];
  note: string;
}

export interface SpecimenObservation {
  observation_id: string;
  metric: string;
  value: string | number;
  unit: string | null;
  specimen_id: string;
  binding: 'explicit' | 'unbound';
  note: string;
}

export interface SpecimenGraph {
  root: string;
  specimens: SpecimenNode[];
  edges: SpecimenEdge[];
  observations: SpecimenObservation[];
  unresolved: string[];
  provenance: 'deterministic_analysis';
}

export function buildSpecimenLineage(record: PublishedRecord, version: RecordReference['version'], store: ResearchStore | null, sampleId: string): SpecimenGraph {
  const chain = preparationChain(record.draft, sampleId);
  const inChain = new Set(chain.map(sample => sample.local_id));
  const specimens: SpecimenNode[] = chain.map(sample => {
    let identity: MaterialIdentity | null = null;
    try { identity = resolveMaterialIdentity(record, version, sample.local_id); }
    catch { identity = null; }
    return {
      specimen_id: specimenId(record.paper.paper_id, sample.local_id),
      paper_id: record.paper.paper_id, sample_id: sample.local_id, name: sample.name,
      material_state: sample.material_state, shared_from: sample.shared_from,
      identity, external: false,
    };
  });

  const edges: SpecimenEdge[] = [];
  for (const sample of chain) {
    if (!sample.shared_from) continue;
    edges.push({
      from: specimenId(record.paper.paper_id, sample.local_id),
      to: specimenId(record.paper.paper_id, sample.shared_from),
      relation: 'preparation_inherits', basis: 'record_shared_from', evidence: [],
      note: 'shared_from 仅表示制备信息继承；不是分装、后处理或因果关系',
    });
  }

  const unresolved: string[] = [];
  if (!chain.some(sample => sample.material_state !== 'as_prepared')) {
    unresolved.push('未记录后处理或测试后状态；材料状态仅为制备后');
  }
  const explicit = store?.listSpecimenRelations(record.paper.paper_id) ?? [];
  const connected = explicit.filter(relation => inChain.has(relation.from_specimen.split('::')[1]) || inChain.has(relation.to_specimen.split('::')[1]));
  for (const relation of connected) {
    for (const id of [relation.from_specimen, relation.to_specimen]) {
      if (specimens.some(node => node.specimen_id === id)) continue;
      const [paperId, sampleLocal] = id.split('::');
      specimens.push({
        specimen_id: id, paper_id: paperId, sample_id: sampleLocal, name: '未在当前记录中',
        material_state: 'unknown', shared_from: null, identity: null, external: true,
      });
      unresolved.push(`关系端点 ${id} 不在当前记录中，只能按外部样品保留`);
    }
    edges.push({
      from: relation.from_specimen, to: relation.to_specimen, relation: relation.relation,
      basis: 'explicit_relation', evidence: relation.evidence,
      note: relation.note || '显式记录的样品关系',
    });
  }
  if (!connected.length) unresolved.push('未记录分装、负载、后处理或测试后状态关系；只有制备继承边');

  const observations = (store?.listObservations(record.paper.paper_id) ?? [])
    .filter(observation => inChain.has(observation.sample_id))
    .map(observation => ({
      observation_id: observation.observation_id, metric: observation.metric,
      value: observation.value, unit: observation.unit,
      specimen_id: specimenId(observation.paper_id, observation.sample_id),
      binding: 'explicit' as const, note: observation.method ? `测量方法：${observation.method}` : '已绑定到该样品记录',
    }));
  const otherObservations = (store?.listObservations(record.paper.paper_id) ?? []).filter(observation => !inChain.has(observation.sample_id));
  if (otherObservations.length) unresolved.push(`该论文另有 ${otherObservations.length} 条观察绑定到其他样品，未并入本条谱系`);

  return { root: specimenId(record.paper.paper_id, sampleId), specimens, edges, observations, unresolved, provenance: 'deterministic_analysis' };
}

export interface ObservationSubject {
  specimen_id: string;
  binding: 'explicit' | 'unbound';
  observation: Observation | null;
  reason: string;
  candidates: string[];
}

/**
 * Resolve which specimen an observation belongs to. Without an explicit observation or
 * `observes` edge the answer is "unbound" — never the initial powder by default.
 */
export function resolveObservationSubject(record: PublishedRecord, store: ResearchStore | null, sampleId: string, metric?: string): ObservationSubject {
  const sample = record.draft.samples.find(item => item.local_id === sampleId);
  if (!sample) throw new Error(`样品不存在：${sampleId}`);
  const id = specimenId(record.paper.paper_id, sampleId);
  const observations = (store?.listObservations(record.paper.paper_id, sampleId) ?? [])
    .filter(observation => !metric || observation.metric === metric);
  const relations = (store?.listSpecimenRelations(record.paper.paper_id) ?? [])
    .filter(relation => relation.relation === 'observes' && (relation.from_specimen === id || relation.to_specimen === id));
  const candidates = [...new Set([id, ...relations.map(relation => relation.from_specimen === id ? relation.to_specimen : relation.from_specimen)])];
  if (observations.length) {
    return { specimen_id: id, binding: 'explicit', observation: observations[0], reason: '观察记录显式绑定到该样品', candidates };
  }
  if (relations.length) {
    return { specimen_id: id, binding: 'explicit', observation: null, reason: '存在显式 observes 关系', candidates };
  }
  return {
    specimen_id: id, binding: 'unbound', observation: null,
    reason: `只有制备样品记录，未记录${metric ? `「${metric}」的` : ''}测量对象；不默认归到初始粉体或制备后状态`,
    candidates,
  };
}
