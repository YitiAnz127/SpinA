import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { ResearchStore } from '../src/research/store.ts';
import { buildSpecimenLineage, resolveObservationSubject, specimenId } from '../src/research/specimens.ts';
import { makeRecord, makeSample, evidence } from './helpers/research-fixtures.mjs';

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'research-specimens-'));
  const store = await ResearchStore.openFile(join(directory, 'research.sqlite'));
  t.after(async () => {
    store.close();
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return { store, directory };
}

const record = () => makeRecord({
  paperId: 'RES-1',
  samples: [
    makeSample({ id: 'S1', name: 'powder' }),
    makeSample({ id: 'S2', name: 'electrode', sharedFrom: 'S1', state: 'post_treatment' }),
  ],
});

test('shared_from becomes a preparation-inheritance edge, not a physical transformation', async t => {
  const { store } = await fixture(t);
  const graph = buildSpecimenLineage(record(), 'verified', store, 'S2');
  assert.deepEqual(graph.specimens.map(node => node.sample_id), ['S1', 'S2']);
  const edge = graph.edges.find(item => item.relation === 'preparation_inherits');
  assert.equal(edge.from, specimenId('RES-1', 'S2'));
  assert.equal(edge.to, specimenId('RES-1', 'S1'));
  assert.equal(edge.basis, 'record_shared_from');
  assert.match(edge.note, /不是分装、后处理或因果/);
  assert.ok(graph.unresolved.some(item => item.includes('未记录分装、负载、后处理或测试后状态关系')));
});

test('explicit relations add state edges and keep their evidence', async t => {
  const { store } = await fixture(t);
  store.addSpecimenRelation({
    relation_id: 'rel-1', paper_id: 'RES-1',
    from_specimen: specimenId('RES-1', 'S1'), to_specimen: specimenId('RES-1', 'S2'),
    relation: 'processed_into', evidence: evidence(3, 'annealed pellet'), note: '原文说明 S2 由 S1 压制后处理得到',
    created_at: '2026-10-01T00:00:00.000Z',
  });
  const graph = buildSpecimenLineage(record(), 'verified', store, 'S2');
  const edge = graph.edges.find(item => item.relation === 'processed_into');
  assert.ok(edge, '显式关系必须进入谱系');
  assert.equal(edge.basis, 'explicit_relation');
  assert.equal(edge.evidence[0].page, 3);
  assert.match(edge.note, /压制后处理/);
});

test('a relation endpoint outside the record is kept as external instead of invented', async t => {
  const { store } = await fixture(t);
  store.addSpecimenRelation({
    relation_id: 'rel-2', paper_id: 'RES-1',
    from_specimen: specimenId('RES-1', 'S2'), to_specimen: specimenId('RES-1', 'S9'),
    relation: 'deposited_on', evidence: [], note: '基底在另一篇论文中', created_at: '2026-10-01T00:00:00.000Z',
  });
  const graph = buildSpecimenLineage(record(), 'verified', store, 'S2');
  const external = graph.specimens.find(node => node.sample_id === 'S9');
  assert.equal(external.external, true);
  assert.equal(external.identity, null);
  assert.ok(graph.unresolved.some(item => item.includes('不在当前记录中')));
});

test('observations bind only where they are recorded, never to the initial powder by default', async t => {
  const { store } = await fixture(t);
  const unbound = resolveObservationSubject(record(), store, 'S2', 'H2 rate');
  assert.equal(unbound.binding, 'unbound');
  assert.match(unbound.reason, /不默认归到初始粉体/);
  store.addObservation({
    observation_id: 'obs-1', paper_id: 'RES-1', sample_id: 'S2', metric: 'H2 rate', value: 120, unit: 'umol g-1 h-1',
    method: 'photocatalysis', context: { light: '300 W Xe' }, evidence: evidence(5), provenance: 'source_reported',
    created_at: '2026-10-01T00:00:00.000Z',
  });
  const bound = resolveObservationSubject(record(), store, 'S2', 'H2 rate');
  assert.equal(bound.binding, 'explicit');
  assert.equal(bound.observation.value, 120);
  const graph = buildSpecimenLineage(record(), 'verified', store, 'S2');
  assert.equal(graph.observations.length, 1);
  assert.equal(graph.observations[0].specimen_id, specimenId('RES-1', 'S2'));
});

test('a sample without a target phase still yields a node with an unresolved identity', async t => {
  const { store } = await fixture(t);
  const source = makeRecord({ paperId: 'RES-2', samples: [makeSample({ id: 'S1', formula: '(Ni,Mn)Fe2O4' })] });
  const graph = buildSpecimenLineage(source, 'verified', store, 'S1');
  assert.equal(graph.specimens.length, 1);
  assert.equal(graph.specimens[0].identity.composition.status, 'unparsed');
  assert.ok(graph.specimens[0].identity.unresolved.some(item => item.includes('无法解析')));
});
