import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { ResearchStore } from '../src/research/store.ts';
import { analyzeSampleSeries } from '../src/research/study-design.ts';
import { makeRecord, makeSample, evidence } from './helpers/research-fixtures.mjs';

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'research-study-'));
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
    makeSample({ id: 'S1', name: 'control', temperature: '900 °C', duration: '4 h' }),
    makeSample({ id: 'S2', name: 'hotter', temperature: '1000 °C', duration: '4 h' }),
    makeSample({ id: 'S3', name: 'confounded', temperature: '1000 °C', duration: '6 h', materials: ['NiO', 'Al2O3'] }),
    makeSample({ id: 'S4', name: 'unknown temp', temperatureStatus: 'not_reported', duration: '4 h' }),
    makeSample({ id: 'S5', name: 'unit mismatch', temperature: '1100 °C', duration: '4 h' }),
    makeSample({ id: 'S6', name: 'unknown duration', temperature: '1100 °C', durationStatus: 'not_reported' }),
  ],
});

function observe(store, sampleId, value, unit = 'umol g-1 h-1', context = { light: '300 W Xe' }) {
  store.addObservation({
    observation_id: `obs-${sampleId}`, paper_id: 'RES-1', sample_id: sampleId, metric: 'H2 rate',
    value, unit, method: 'photocatalysis', context, evidence: evidence(4),
    provenance: 'source_reported', created_at: '2026-10-01T00:00:00.000Z',
  });
}

test('a single reported variable with no observations stops at design analysis', async t => {
  const { store } = await fixture(t);
  const contrast = analyzeSampleSeries(record(), 'verified', store, { control: 'S1' });
  const s2 = contrast.contrasts.find(item => item.sample_id === 'S2');
  assert.deepEqual(s2.varied.map(item => item.label), ['条件 temperature']);
  assert.ok(s2.held_constant.some(item => item.label === '条件 duration'));
  assert.ok(s2.held_constant.some(item => item.label === '原料集合'));
  assert.equal(s2.confounded, false);
  assert.equal(s2.assessment.status, 'insufficient_observations');
  assert.match(s2.assessment.explanation, /没有绑定到这两个样品的结果观察/);
});

test('simultaneous changes are reported as non-attributable with the specific variables', async t => {
  const { store } = await fixture(t);
  const contrast = analyzeSampleSeries(record(), 'verified', store, { control: 'S1' });
  const s3 = contrast.contrasts.find(item => item.sample_id === 'S3');
  assert.equal(s3.confounded, true);
  assert.equal(s3.varied.length, 3);
  assert.equal(s3.assessment.status, 'cannot_isolate_variable');
  for (const label of ['条件 temperature', '条件 duration', '原料集合']) {
    assert.ok(s3.varied.some(item => item.label === label), `缺少变量 ${label}`);
  }
  assert.match(s3.assessment.explanation, /不能把观察差异单独归因于其中任何一个/);
});

test('an unreported condition is not treated as a controlled one', async t => {
  const { store } = await fixture(t);
  const contrast = analyzeSampleSeries(record(), 'verified', store, { control: 'S1' });
  const s4 = contrast.contrasts.find(item => item.sample_id === 'S4');
  assert.equal(s4.varied.length, 0);
  assert.ok(s4.unreported.some(item => item.label === '条件 temperature'));
  assert.equal(s4.assessment.status, 'unresolved_design');
  assert.match(s4.assessment.explanation, /未报告或名称未对齐/);
  const s6 = contrast.contrasts.find(item => item.sample_id === 'S6');
  assert.ok(s6.unreported.some(item => item.label === '条件 duration'));
  assert.equal(s6.assessment.status, 'partially_controlled');
});

test('comparable observations produce a delta, incompatible units do not', async t => {
  const { store } = await fixture(t);
  observe(store, 'S1', 100);
  observe(store, 'S2', 150);
  observe(store, 'S5', 0.18, 'mmol g-1 h-1');
  const contrast = analyzeSampleSeries(record(), 'verified', store, { control: 'S1' });
  const s2 = contrast.contrasts.find(item => item.sample_id === 'S2');
  assert.equal(s2.observations[0].comparable, true);
  assert.equal(s2.observations[0].delta, 50);
  assert.equal(s2.assessment.status, 'single_variable_contrast');
  assert.match(s2.assessment.explanation, /不是因果证明/);
  const s5 = contrast.contrasts.find(item => item.sample_id === 'S5');
  assert.equal(s5.observations[0].comparable, false);
  assert.match(s5.observations[0].reason, /单位不同/);
  assert.equal(s5.assessment.status, 'measurement_not_comparable');
});

test('different measurement context makes an observation incomparable', async t => {
  const { store } = await fixture(t);
  observe(store, 'S1', 100);
  observe(store, 'S2', 150, 'umol g-1 h-1', { light: '500 W Xe' });
  const contrast = analyzeSampleSeries(record(), 'verified', store, { control: 'S1' });
  const s2 = contrast.contrasts.find(item => item.sample_id === 'S2');
  assert.equal(s2.observations[0].comparable, false);
  assert.match(s2.observations[0].reason, /测量条件不一致/);
});

test('the series analysis attaches author interpretations and keeps its limits explicit', async t => {
  const { store } = await fixture(t);
  store.addClaim({
    claim_id: 'c1', paper_id: 'RES-1', topic: 'activity_origin',
    statement: '性能提升来自退火温度', kind: 'author_interpretation', stance: 'positive',
    subject_refs: [{ paper_id: 'RES-1', sample_id: 'S2' }], scope: {}, support_refs: [], assumptions: [],
    counter_refs: [], origin_family: 'paper:RES-1', relations: [], evidence: [], created_at: '2026-10-01T00:00:00.000Z',
  });
  const contrast = analyzeSampleSeries(record(), 'verified', store, { control: 'S1' });
  assert.deepEqual(contrast.author_claims.map(item => item.claim_id), ['c1']);
  assert.ok(contrast.unresolved.some(item => item.includes('空字段按“未报告”处理')));
  assert.ok(contrast.unresolved.some(item => item.includes('不会被自动换算')));
});

test('cross-paper pooling is rejected rather than silently merged', async t => {
  const { store } = await fixture(t);
  assert.throws(() => analyzeSampleSeries(makeRecord({ samples: [makeSample({ id: 'S1' })] }), 'verified', store, {}), /至少需要两个/);
});

test('unreported measurement conditions cannot establish a quantitative contrast', async t => {
  const { store } = await fixture(t);
  for (const id of ['S1', 'S2']) observe(store, id, 100, 'mV', {});
  const result = analyzeSampleSeries(record(), 'verified', store, {control:'S1', samples:['S1','S2']});
  assert.equal(result.contrasts[0].assessment.status, 'measurement_not_comparable');
  assert.equal(result.contrasts[0].observations[0].delta, null);
});
