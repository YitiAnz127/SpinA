import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { ExperimentStore } from '../src/distillation/store.ts';
import { deriveMetalElements } from '../src/distillation/schema.ts';
import { assessRoute, searchRouteConstraintsWith, RouteConstraintQuerySchema } from '../src/distillation/route.ts';
import { Check } from 'typebox/value';

const evidence = [{ source_id: 'src_1', page: 1, quote: 'fixture' }];
const fact = (raw, value, unit = null, status = 'reported') => ({
  raw, value, unit, status, evidence: status === 'reported' ? evidence : [], note: '',
});
const empty = () => ({ raw: null, value: null, unit: null, status: 'not_reported', evidence: [], note: '' });

const step = (id, operation, options = {}) => ({
  local_id: id, operation: fact(operation, operation), description: empty(), material_refs: ['M1'],
  conditions: [
    ...(options.temperature !== undefined
      ? [{ name: 'temperature', fact: options.temperatureStatus === 'not_reported' ? { ...empty(), note: '原文未报告温度' } : fact(options.temperature, options.temperature, '°C') }]
      : []),
    ...(options.duration !== undefined
      ? [{ name: 'duration', fact: options.durationStatus === 'not_reported' ? { ...empty(), note: '原文未报告时长' } : fact(options.duration, options.duration, 'h') }]
      : []),
  ],
});

const sample = (id, steps, options = {}) => ({
  local_id: id, name: id, aliases: [], material_state: 'as_prepared',
  variables: (options.variables ?? []).map(variable => ({ name: variable.name, fact: fact(variable.value, variable.value, variable.unit ?? null) })),
  nominal_composition: empty(), measured_composition: empty(),
  phases: [{ local_id: 'P1', role: 'target_spinel', formula: fact('NiFe2O4', 'NiFe2O4'), identity: fact('spinel', 'spinel'), purity: empty() }],
  method: fact('co-precipitation', 'co-precipitation'),
  materials: [{ local_id: 'M1', identity: fact('NiO', 'NiO'), role: 'precursor', amount: fact('1 g', '1 g', 'g'), concentration: empty() }],
  steps, shared_from: options.sharedFrom ?? null, unresolved_questions: [],
});

function record() {
  const samples = [
    sample('S1', [step('ST1', 'annealing', { temperature: '900 °C', duration: '4 h' }), step('ST2', 'drying', { temperature: '80 °C', duration: '12 h' })]),
    sample('S2', [step('ST3', 'sintering', { temperature: '1200 °C', duration: '2 h' })], { sharedFrom: 'S1' }),
    sample('S3', [step('ST1', 'annealing', { temperature: '350–400 °C', duration: '2 h' }), step('ST2', 'drying', { temperature: '80 °C', duration: '12 h' })]),
    sample('S4', [step('ST1', 'annealing', { temperature: '900 °C', temperatureStatus: 'not_reported', duration: '4 h' })]),
    sample('S5', [step('ST1', 'drying', { temperature: '300 °C', duration: '1 h' }), step('ST2', 'annealing', { temperature: '900 °C', duration: '1 h' })]),
    sample('S6', [step('ST1', 'annealing', { temperature: '200 °C 1 h → 400 °C 2 h', duration: '3 h' })]),
    sample('S7', [step('ST1', 'ball milling', { duration: '2 h' }), step('ST2', 'annealing', { temperature: '700 °C', duration: '2 h' })]),
    sample('S8', [step('ST1', 'annealing', { temperature: '700 °C', duration: '2 h' }), step('ST2', 'drying', { durationStatus: 'not_reported' })]),
    sample('S9', [step('ST1', '煅烧', { temperature: '800 °C', duration: '3 h' })]),
    sample('S10', [step('ST1', 'annealing', { duration: '4 h' })], { variables: [{ name: 'annealing_temperature', value: '1000 °C', unit: '°C' }] }),
  ];
  return {
    schema_version: 1, paper: { paper_id: 'ROUTE-1', doi: '10.1234/route', title: 'Route fixture' },
    revision: 1, verified_at: '2026-10-01T00:00:00.000Z', verified_by: 'fixture', verification_status: 'verified',
    sources: [{ id: 'src_1', path: 'data/paper/fixture.pdf', kind: 'body', page_count: 5, empty_text_pages: [] }],
    draft: { assessment: 'original_experiments', notes: [], samples },
    verification: {
      source_identity: 'confirmed', coverage: 'complete', issues: [], notes: [],
      samples: samples.map(item => ({ sample_local_id: item.local_id, has_confirmed_errors: false, has_unresolved_issues: false, can_match: true, expandable_fields: [], missing_or_uncertain: [] })),
    },
    match_entries: samples.map(item => {
      const metals = deriveMetalElements('NiFe2O4');
      return { sample_local_id: item.local_id, phase_local_id: 'P1', metal_elements: metals, element_key: metals.join('|'), material_state: item.material_state };
    }),
  };
}

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'route-'));
  const store = await ExperimentStore.open(root);
  store.publish(record(), store.getPaperState('ROUTE-1'));
  t.after(async () => {
    store.close();
    const rel = relative(base, root);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  });
  return { store, root };
}

const assessment = (query, sampleId) => {
  const source = record();
  const target = source.draft.samples.find(item => item.local_id === sampleId);
  return assessRoute(source, 'verified', target, query);
};

test('route structure states the ordering basis instead of implying a verified sequence', () => {
  const route = assessment({ max_temperature: 400 }, 'S1');
  assert.equal(route.route.structure.ordering_basis, 'record_order');
  assert.equal(route.route.structure.parallelism_known, false);
  assert.equal(route.route.structure.replacement_known, false);
  assert.ok(route.route.structure.warnings.some(item => item.includes('未标注并行或替换关系')));
  assert.deepEqual(route.route.steps.map(step => step.origin), ['own', 'own']);
});

test('inherited steps are marked and counted separately from the sample own steps', () => {
  const route = assessment({ max_temperature: 1300 }, 'S2');
  assert.equal(route.route.structure.inherited_step_count, 2);
  assert.deepEqual(route.route.steps.map(step => `${step.step_id}:${step.origin}`), ['ST1:inherited', 'ST2:inherited', 'ST3:own']);
  assert.deepEqual(route.route.structure.inheritance.map(item => item.sample_id), ['S1', 'S2']);
  assert.ok(route.route.structure.warnings.some(item => item.includes('来自共用流程')));
});

test('the schema requires at least one route constraint', () => {
  assert.equal(Check(RouteConstraintQuerySchema, {}), false);
  assert.equal(Check(RouteConstraintQuerySchema, { metal_elements: ['Ni', 'Fe'] }), false);
  assert.equal(Check(RouteConstraintQuerySchema, { max_temperature: 400 }), true);
  assert.equal(Check(RouteConstraintQuerySchema, { required_operations: ['annealing'] }), true);
});

test('a route aggregates every step and reports the real maximum', () => {
  const route = assessment({ max_temperature: 1000 }, 'S1');
  assert.equal(route.route.step_count, 2);
  assert.equal(route.max_temperature.status, 'satisfied');
  assert.equal(route.max_temperature.value, 900);
  assert.equal(route.overall, 'satisfied');
});

test('a single low-temperature step does not make the route satisfy a low limit', () => {
  const route = assessment({ max_temperature: 400 }, 'S5');
  assert.equal(route.max_temperature.status, 'violated');
  assert.equal(route.max_temperature.value, 900);
  assert.match(route.max_temperature.detail, /ST2/);
  assert.equal(route.overall, 'violated');
});

test('a range uses its upper bound, not its midpoint', () => {
  const route = assessment({ max_temperature: 400, max_total_duration_hours: 24 }, 'S3');
  assert.equal(route.max_temperature.status, 'satisfied');
  assert.equal(route.max_temperature.value, 400);
  assert.equal(route.total_duration.status, 'satisfied');
  assert.equal(route.total_duration.upper_bound, 14 * 3600);
});

test('an unreported temperature keeps the route undetermined instead of satisfied', () => {
  const route = assessment({ max_temperature: 1000 }, 'S4');
  assert.equal(route.max_temperature.status, 'undetermined');
  assert.deepEqual(route.max_temperature.unknown_steps, ['ST1']);
  assert.equal(route.overall, 'undetermined');
});

test('shared ancestors are included in the child route', () => {
  const route = assessment({ max_temperature: 1000 }, 'S2');
  assert.equal(route.route.step_count, 3);
  assert.deepEqual(route.route.steps.map(item => item.step_id), ['ST1', 'ST2', 'ST3']);
  assert.equal(route.max_temperature.status, 'violated');
  assert.equal(route.max_temperature.value, 1200);
});

test('a missing duration only yields a lower bound and an undetermined total', () => {
  const route = assessment({ max_total_duration_hours: 24 }, 'S8');
  assert.equal(route.total_duration.status, 'undetermined');
  assert.equal(route.total_duration.value, 2 * 3600);
  assert.equal(route.total_duration.upper_bound, null);
  assert.deepEqual(route.total_duration.unknown_steps, ['ST2']);
  assert.match(route.total_duration.detail, /至少 2\.00 h/);
});

test('a programme contributes its maximum and the sum of its holds', () => {
  const route = assessment({ max_temperature: 400, max_total_duration_hours: 3 }, 'S6');
  assert.equal(route.max_temperature.status, 'satisfied');
  assert.equal(route.max_temperature.value, 400);
  assert.equal(route.total_duration.status, 'satisfied');
  assert.equal(route.total_duration.upper_bound, 3 * 3600);
});

test('required operations use controlled synonyms and absence stays undetermined', () => {
  const matched = assessment({ required_operations: ['退火'] }, 'S1');
  assert.equal(matched.operations.required[0].status, 'satisfied');
  assert.deepEqual(matched.operations.required[0].matched_steps, ['ST1']);
  const absent = assessment({ required_operations: ['ball milling'] }, 'S1');
  assert.equal(absent.operations.required[0].status, 'undetermined');
  assert.match(absent.operations.required[0].detail, /不能证明实际未使用/);
  const chinese = assessment({ required_operations: ['calcination'] }, 'S9');
  assert.equal(chinese.operations.required[0].status, 'satisfied');
});

test('a forbidden operation that appears is a violation, and its absence is unknown', () => {
  const violated = assessment({ forbidden_operations: ['ball-milling'] }, 'S7');
  assert.equal(violated.operations.forbidden[0].status, 'violated');
  assert.equal(violated.overall, 'violated');
  const clean = assessment({ forbidden_operations: ['ball-milling'] }, 'S1');
  assert.equal(clean.operations.forbidden[0].status, 'undetermined');
});

test('sample-level conditions not bound to a step are reported, not silently aggregated', () => {
  const route = assessment({ max_temperature: 1000 }, 'S10');
  assert.deepEqual(route.route.unbound_conditions.map(item => item.name), ['annealing_temperature']);
  assert.ok(route.reasons.some(reason => reason.includes('未绑定到步骤')));
});

test('search filters by metal set and returns three-state counts', async t => {
  const { store } = await fixture(t);
  const result = searchRouteConstraintsWith(store, { max_temperature: 400, limit: 100 });
  assert.ok(result.total >= 10);
  assert.equal(result.satisfied + result.undetermined + result.violated, result.total);
  const s5 = result.results.find(item => item.sample_id === 'S5');
  assert.equal(s5.overall, 'violated');
  const s3 = result.results.find(item => item.sample_id === 'S3');
  assert.equal(s3.overall, 'satisfied');
  const filtered = searchRouteConstraintsWith(store, { metal_elements: ['Co'], max_temperature: 400 });
  assert.equal(filtered.total, 0);
  const sorted = result.results.map(item => item.overall);
  assert.ok(sorted.indexOf('satisfied') <= sorted.indexOf('violated'));
});

test('a query without constraints or with invalid values is rejected', async t => {
  const { store } = await fixture(t);
  assert.throws(() => searchRouteConstraintsWith(store, { metal_elements: ['Ni', 'Fe'] }), /至少需要/);
  assert.throws(() => searchRouteConstraintsWith(store, { max_temperature: 400, limit: 0 }), /分页参数/);
  assert.throws(() => searchRouteConstraintsWith(store, { max_total_duration_hours: -1 }), /max_total_duration_hours/);
  assert.throws(() => searchRouteConstraintsWith(store, { max_temperature: 400, required_operations: ['  '] }), /不能为空/);
});

test('zero limits, missing steps and one-sided bounds do not become false decisions', () => {
  assert.equal(searchRouteConstraintsWith(null, { max_temperature: 0 }).total, 0);
  assert.equal(searchRouteConstraintsWith(null, { max_total_duration_hours: 0 }).total, 0);
  const rec = record();
  for (const [raw, expected] of [['≤ 600 °C', 'undetermined'], ['> 400 °C', 'violated'], ['about 400 °C', 'undetermined']]) {
    const target = sample('boundary', [step('s', 'anneal', { temperature: raw })]);
    rec.draft.samples = [target];
    assert.equal(assessRoute(rec, 'verified', target, { max_temperature: 400 }).overall, expected);
  }
  assert.equal(assessment({ max_temperature: 1000 }, 'S8').overall, 'undetermined');
});
