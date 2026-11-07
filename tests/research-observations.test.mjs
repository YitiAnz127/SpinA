import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ResearchStore } from '../src/research/store.ts';
import { extractTableObservations, toObservation, METRIC_GROUPS } from '../src/research/facets/observations.ts';
import { analyzeSampleSeries } from '../src/research/study-design.ts';
import { makeRecord, makeSample } from './helpers/research-fixtures.mjs';

const CONTEXT = 'Photocatalytic H2 evolution was measured under a 300 W Xe lamp using TEOA as the sacrificial agent.';

const record = (revision = 1) => makeRecord({
  paperId: 'OBS-1', revision,
  verifiedAt: revision === 1 ? '2026-10-01T00:00:00.000Z' : '2026-10-02T00:00:00.000Z',
  samples: [
    makeSample({ id: 'S1', name: 'control', temperature: '900 °C', duration: '4 h' }),
    makeSample({ id: 'S2', name: 'hotter', temperature: '1000 °C', duration: '4 h' }),
  ],
});

const table = rows => ({
  id: 'src_1', path: 'data/paper/fixture.pdf', kind: 'body',
  pages: [{ number: 3, text: CONTEXT, tables: [{ bbox: [0, 0, 1, 1], rows }] }],
});

const METRIC_TABLE = [
  ['Sample', 'H2 evolution rate (umol g-1 h-1)', 'Conditions'],
  ['S1', '120', '300 W Xe'],
  ['S2', '180', '300 W Xe'],
];

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'research-observations-'));
  const store = await ResearchStore.openFile(join(directory, 'research.sqlite'));
  t.after(async () => {
    store.close();
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return { store, directory };
}

const save = (store, extraction) => {
  for (const candidate of extraction.candidates) store.addObservation(toObservation(candidate));
};

test('a table row becomes an observation with sample, unit, method, context and evidence', () => {
  const extraction = extractTableObservations(record(), [table(METRIC_TABLE)], { metric: 'h2_evolution_rate' });
  assert.equal(extraction.tables_scanned, 1);
  assert.equal(extraction.candidates.length, 2);
  const [first, second] = extraction.candidates;
  assert.equal(first.sample_id, 'S1');
  assert.equal(first.matched_label, 'S1');
  assert.equal(first.value, 120);
  assert.equal(first.unit, 'umol g-1 h-1');
  assert.equal(first.method, 'Photocatalytic');
  assert.equal(first.context.light_source, '300 W Xe lamp');
  assert.equal(first.context.sacrificial_agent, 'TEOA');
  assert.equal(first.context_status, 'complete');
  assert.equal(first.confidence, 'high');
  assert.equal(first.record_ref.revision, 1);
  assert.equal(first.record_ref.verified_at, '2026-10-01T00:00:00.000Z');
  assert.equal(first.evidence[0].page, 3);
  assert.match(first.evidence[0].quote, /S1 \| H2 evolution rate/);
  assert.equal(second.value, 180);
});

test('unmatched labels and unparsable cells are listed instead of dropped', () => {
  const extraction = extractTableObservations(record(), [table([
    ['Sample', 'H2 evolution rate (umol g-1 h-1)'],
    ['S1', '120'],
    ['S9', '90'],
    ['S2', 'n.r.'],
  ])], { metric: 'h2_evolution_rate' });
  assert.equal(extraction.candidates.length, 1);
  assert.deepEqual(extraction.unmatched_labels.map(item => item.label), ['S9']);
  assert.deepEqual(extraction.unmatched_labels[0].candidates, ['S1', 'S2']);
  assert.deepEqual(extraction.skipped.map(item => item.label), ['S2']);
});

test('scientific notation and uncertainty are parsed with an explicit warning', () => {
  const extraction = extractTableObservations(record(), [table([
    ['Sample', 'H2 evolution rate (umol g-1 h-1)'],
    ['S1', '1.2 × 10^2'],
    ['S2', '180 ± 5'],
  ])], { metric: 'h2_evolution_rate' });
  assert.equal(extraction.candidates[0].value, 120);
  assert.ok(extraction.candidates[0].warnings.includes('scientific_notation'));
  assert.equal(extraction.candidates[1].value, 180);
  assert.ok(extraction.candidates[1].warnings.includes('uncertainty_dropped'));
});

test('a table without the requested metric is reported as unsupported', () => {
  const extraction = extractTableObservations(record(), [table([
    ['Sample', 'Band gap (eV)'],
    ['S1', '2.1'],
  ])], { metric: 'h2_evolution_rate' });
  assert.equal(extraction.candidates.length, 0);
  assert.equal(extraction.metric_label, null);
  assert.ok(extraction.unresolved.some(item => item.includes('未在任何表格中找到指标列')));
});

test('a unit row below the header is still read', () => {
  const extraction = extractTableObservations(record(), [table([
    ['Sample', 'H2 evolution rate', 'Conditions'],
    ['', '(umol g-1 h-1)', ''],
    ['S1', '120', '300 W Xe'],
    ['S2', '180', '300 W Xe'],
  ])], { metric: 'h2_evolution_rate' });
  assert.equal(extraction.candidates.length, 2);
  assert.equal(extraction.candidates[0].unit, 'umol g-1 h-1');
});

test('a manual map resolves labels that do not match the record', () => {
  const extraction = extractTableObservations(record(), [table([
    ['Sample', 'H2 evolution rate (umol g-1 h-1)'],
    ['Cat-A', '120'],
    ['Cat-B', '180'],
  ])], { metric: 'h2_evolution_rate', sample_map: { 'Cat-A': 'S1', 'Cat-B': 'S2' } });
  assert.deepEqual(extraction.candidates.map(item => item.sample_id), ['S1', 'S2']);
  assert.equal(extraction.candidates[0].confidence, 'high');
});

test('table_index selects a single table', () => {
  const document = {
    id: 'src_1', path: 'data/paper/fixture.pdf', kind: 'body',
    pages: [{ number: 3, text: CONTEXT, tables: [
      { bbox: [0, 0, 1, 1], rows: [['Sample', 'Band gap (eV)'], ['S1', '2.1']] },
      { bbox: [0, 0, 1, 1], rows: METRIC_TABLE },
    ] }],
  };
  const extraction = extractTableObservations(record(), [document], { metric: 'h2_evolution_rate', table_index: 1 });
  assert.equal(extraction.tables_scanned, 1);
  assert.equal(extraction.candidates.length, 2);
});

test('extracted observations feed the series comparison and produce a comparable delta', async t => {
  const { store } = await fixture(t);
  const extraction = extractTableObservations(record(), [table(METRIC_TABLE)], { metric: 'h2_evolution_rate' });
  save(store, extraction);
  const contrast = analyzeSampleSeries(record(), 'verified', store, { control: 'S1', samples: ['S1', 'S2'] });
  const observation = contrast.contrasts[0].observations[0];
  assert.equal(observation.comparability, 'comparable');
  assert.equal(observation.comparable, true);
  assert.equal(observation.delta, 60);
  assert.equal(observation.context_status, 'matched');
  assert.equal(observation.evidence_version.status, 'current');
  assert.equal(contrast.contrasts[0].assessment.status, 'single_variable_contrast');
  assert.match(observation.reason, /同单位、同测量方法及条件下差值 60/);
});

test('a page without measurement context yields no quantitative contrast', async t => {
  const { store } = await fixture(t);
  const document = table(METRIC_TABLE);
  document.pages[0].text = 'Table 1 summarizes the measured rates.';
  const extraction = extractTableObservations(record(), [document], { metric: 'h2_evolution_rate' });
  assert.equal(extraction.candidates[0].context_status, 'unknown');
  assert.equal(extraction.candidates[0].method, null);
  save(store, extraction);
  const contrast = analyzeSampleSeries(record(), 'verified', store, { control: 'S1', samples: ['S1', 'S2'] });
  const observation = contrast.contrasts[0].observations[0];
  assert.equal(observation.comparability, 'incomparable');
  assert.equal(observation.delta, null);
  assert.match(observation.reason, /测量方法或测量条件缺失/);
  assert.equal(contrast.contrasts[0].assessment.status, 'measurement_not_comparable');
});

test('observations bound to an older revision are rejected as stale', async t => {
  const { store } = await fixture(t);
  const extraction = extractTableObservations(record(1), [table(METRIC_TABLE)], { metric: 'h2_evolution_rate' });
  save(store, extraction);
  const contrast = analyzeSampleSeries(record(2), 'verified', store, { control: 'S1', samples: ['S1', 'S2'] });
  const observation = contrast.contrasts[0].observations[0];
  assert.equal(observation.evidence_version.status, 'stale');
  assert.equal(observation.comparable, false);
  assert.equal(observation.delta, null);
  assert.match(observation.reason, /样品化学指纹未变，但修订已更新/);
});

test('a re-distillation that rewrites the sample chemistry blocks the old delta', async t => {
  const { store } = await fixture(t);
  save(store, extractTableObservations(record(1), [table(METRIC_TABLE)], { metric: 'h2_evolution_rate' }));
  const rewritten = makeRecord({
    paperId: 'OBS-1', revision: 2, verifiedAt: '2026-10-02T00:00:00.000Z',
    samples: [
      makeSample({ id: 'S1', name: 'control', formula: 'Ni0.5Zn0.5Fe2O4', temperature: '900 °C' }),
      makeSample({ id: 'S2', name: 'hotter', formula: 'Ni0.5Zn0.5Fe2O4', temperature: '1000 °C' }),
    ],
  });
  const contrast = analyzeSampleSeries(rewritten, 'verified', store, { control: 'S1', samples: ['S1', 'S2'] });
  const observation = contrast.contrasts[0].observations[0];
  assert.equal(observation.evidence_version.status, 'stale');
  assert.equal(observation.comparable, false);
  assert.match(observation.reason, /样品已不是原记录中的材料/);
});

test('an older research database gains the version column without manual migration', async t => {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'research-migration-'));
  const path = join(directory, 'research.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE observations (
    observation_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, sample_id TEXT NOT NULL,
    metric TEXT NOT NULL, value_json TEXT NOT NULL, unit TEXT, method TEXT,
    context_json TEXT, evidence_json TEXT, provenance TEXT NOT NULL, created_at TEXT NOT NULL)`);
  legacy.close();
  const store = await ResearchStore.openFile(path);
  try {
    store.addObservation({
      observation_id: 'obs-legacy', paper_id: 'P1', sample_id: 'S1', metric: 'h2', value: 1, unit: 'a',
      method: 'm', context: { light: 'x' }, evidence: [], provenance: 'source_reported',
      record_ref: { paper_id: 'P1', version: 'verified', revision: 2, verified_at: '2026-10-02T00:00:00.000Z' },
      created_at: '2026-10-02T00:00:00.000Z',
    });
    assert.equal(store.listObservations('P1', 'S1')[0].record_ref.revision, 2);
  } finally {
    store.close();
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('an electrolyte written in the sample label becomes measurement context', () => {
  const extraction = extractTableObservations(record(), [table([
    ['Catalyst', 'Overpotential [mV]'],
    ['S1 in 1.0 M NaOH', '340'],
    ['S2 in 1.0 M NaOH', '380'],
  ])], { metric: 'oer_overpotential' });
  assert.equal(extraction.candidates.length, 2);
  assert.equal(extraction.candidates[0].context.electrolyte, '1.0 M NaOH');
  assert.equal(extraction.candidates[0].unit, 'mV');
});

test('the metric table covers the documented first metric', () => {
  assert.ok(METRIC_GROUPS.h2_evolution_rate.includes('产氢速率'));
  assert.ok(METRIC_GROUPS.h2_evolution_rate.includes('hydrogen evolution rate'));
});
