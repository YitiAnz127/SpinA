import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentStore } from '../src/distillation/store.ts';
import { parseDraft } from '../src/distillation/schema.ts';
import spina from '../src/spina.ts';

const base = fileURLToPath(new URL('../.runtime/tests/', import.meta.url));
const fact = raw => ({ raw, evidence: [{ source_id: 'src_1', page: 1, quote: raw }] });
function sample(id, fields = {}) {
  return parseDraft(JSON.stringify({ assessment: 'original_experiments', samples: [{
    local_id: id, name: id, material_state: 'as_prepared',
    phases: [{ local_id: 'phase', role: 'target_spinel', identity: fact('spinel') }], ...fields,
  }] })).samples[0];
}
function record(id, samples, metals = ['Fe', 'Ni']) {
  return {
    schema_version: 1, paper: { paper_id: id, doi: `10.1234/${id}`, title: id },
    revision: 1, verified_at: '2026-10-01T00:00:00.000Z', verified_by: 'fixture', verification_status: 'verified',
    sources: [{ id: 'src_1', path: 'data/paper/fixture.pdf', kind: 'body', page_count: 1, empty_text_pages: [] }],
    draft: { assessment: 'original_experiments', samples, notes: [] },
    verification: { source_identity: 'confirmed', coverage: 'complete', issues: [], notes: [], samples: samples.map(s => ({
      sample_local_id: s.local_id, has_confirmed_errors: false, has_unresolved_issues: false,
      can_match: true, expandable_fields: [], missing_or_uncertain: [],
    })) },
    match_entries: samples.map(s => ({ sample_local_id: s.local_id, phase_local_id: 'phase',
      metal_elements: [...metals].sort(), element_key: [...metals].sort().join('|'), material_state: s.material_state })),
  };
}
async function fixture(t) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'search-'));
  const store = await ExperimentStore.open(root);
  t.after(async () => {
    store.close();
    const rel = relative(base, root);
    assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  });
  const tools = new Map();
  spina({ registerTool: tool => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} });
  const call = async (name, params, cwd = root) => (await tools.get(name).execute('fixture', params, undefined, undefined, { cwd })).details;
  return { root, store, call };
}

test('search totals cover every page and empty/out-of-range pages retain metadata', async t => {
  const { store } = await fixture(t);
  store.publish(record('P1', Array.from({ length: 23 }, (_, i) => sample(`s${String(i).padStart(2, '0')}`))), store.getPaperState('P1'));
  const first = store.searchByElements(['Ni', 'Fe', 'Ni']);
  assert.equal(first.total, 23);
  assert.equal(first.results.length, 20);
  assert.equal(first.has_more, true);
  assert.equal(first.next_offset, 20);
  const last = store.searchByElements(['Fe', 'Ni'], { offset: first.next_offset });
  assert.equal(last.total, 23);
  assert.equal(last.results.length, 3);
  assert.equal(last.has_more, false);
  assert.equal(last.next_offset, null);
  assert.equal(new Set([...first.results, ...last.results].map(x => x.sample_id)).size, 23);
  const pastEnd = store.searchByElements(['Fe', 'Ni'], { offset: 30 });
  assert.equal(pastEnd.total, 23);
  assert.deepEqual(pastEnd.results, []);
  assert.equal(pastEnd.has_more, false);
  const absent = store.searchByElements(['Zn']);
  assert.equal(absent.total, 0);
  assert.deepEqual(absent.results, []);
  assert.throws(() => store.searchByElements(['Ni'], { offset: -1 }), /offset/);
  assert.throws(() => store.searchByElements(['Ni'], { limit: 101 }), /limit/);
});

test('exact results stay separate from paginated strict-superset hints with uncertainty preserved', async t => {
  const { store } = await fixture(t);
  store.publish(record('P1', [sample('exact')]), store.getPaperState('P1'));
  store.publish(record('P2', [sample('related')], ['Co', 'Fe', 'Ni']), store.getPaperState('P2'));
  store.publish(record('P3', [sample('unrelated')], ['Co', 'Ni']), store.getPaperState('P3'));
  const uncertain = record('P4', [sample('possible', { unresolved_questions: ['Target identity unresolved'] })], ['Fe', 'Ni', 'Zn']);
  uncertain.verification_status = 'uncertain';
  uncertain.candidate_match_entries = uncertain.match_entries;
  uncertain.match_entries = [];
  store.publish(uncertain, store.getPaperState('P4'));
  const exact = store.searchByElements(['Ni', 'Fe']);
  assert.deepEqual(exact.results.map(x => x.sample_id), ['exact']);
  assert.equal(exact.related.total, 2);
  assert.equal(exact.related.possible, 1);
  assert.deepEqual(exact.related.metal_sets.map(x => x.metal_elements), [['Co', 'Fe', 'Ni'], ['Fe', 'Ni', 'Zn']]);
  const first = store.searchByElements(['Ni', 'Fe'], { match: 'superset', limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.results[0].sample_id, 'related');
  const last = store.searchByElements(['Fe', 'Ni'], { match: 'superset', limit: 1, offset: first.next_offset });
  assert.equal(last.results[0].possible, true);
  assert.equal(last.results[0].certainty, 'uncertain');
  assert.ok(last.results[0].notes.includes('Target identity unresolved'));
  const confirmed = store.searchByElements(['Fe', 'Ni'], { includeUncertain: false });
  assert.equal(confirmed.related.total, 1);
});

test('method outlines follow explicit shared procedures while preserving local qualifications', async t => {
  const { store } = await fixture(t);
  const parent = sample('parent', { method: fact('sol-gel synthesis') });
  const child = sample('child', { shared_from: 'parent' });
  const own = sample('own', { shared_from: 'parent', method: fact('hydrothermal synthesis') });
  const unknown = sample('unknown', { shared_from: 'parent', method: { raw: null, evidence: [], status: 'ambiguous', note: 'Method assignment unclear' } });
  const r = record('P1', [parent, child, own, unknown]);
  r.match_entries = r.match_entries.filter(x => x.sample_local_id !== 'parent');
  store.publish(r, store.getPaperState('P1'));
  const rows = store.searchByElements(['Fe', 'Ni']).results;
  assert.deepEqual(rows.find(x => x.sample_id === 'child').method_summary, {
    text: 'sol-gel synthesis', status: 'reported', source_sample_id: 'parent',
  });
  assert.equal(rows.find(x => x.sample_id === 'own').method_summary.text, 'hydrothermal synthesis');
  assert.equal(rows.find(x => x.sample_id === 'unknown').method_summary.status, 'ambiguous');
  assert.equal(rows.find(x => x.sample_id === 'unknown').method_summary.note, 'Method assignment unclear');
});

test('native search paginates results and expands the exact coexisting version that was matched', async t => {
  const { store, call } = await fixture(t);
  store.publish(record('P1', [sample('old')]), store.getPaperState('P1'));
  const uncertain = record('P1', [sample('new', { method: fact('sol-gel synthesis') })]);
  uncertain.verification_status = 'uncertain'; uncertain.revision = 2;
  uncertain.verified_at = '2026-10-02T00:00:00.000Z';
  store.publish(uncertain, store.getPaperState('P1'));
  const first = await call('search_spinel_experiments', { metal_elements: ['Ni', 'Fe'], limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.results[0].record_ref.version, 'verified');
  const second = await call('search_spinel_experiments', { metal_elements: ['Ni', 'Fe'], offset: first.next_offset, limit: 1 });
  const hit = second.results[0];
  assert.equal(hit.sample_id, 'new');
  const detail = await call('get_distillation_result', hit.record_ref);
  assert.deepEqual(detail.record_ref, hit.record_ref);
  assert.equal(detail.samples[0].id, hit.sample_id);
  assert.equal(detail.samples[0].method, 'sol-gel synthesis');
  const preferred = await call('get_distillation_result', { paper_id: 'P1' });
  assert.equal(preferred.samples[0].id, 'old');
  assert.equal(preferred.record_ref.version, 'verified');
  const explicit = await call('get_distillation_result', first.results[0].record_ref);
  assert.equal(explicit.samples[0].id, 'old');
});

test('pinned reads reject replaced or removed records instead of silently falling back', async t => {
  const { store, call } = await fixture(t);
  store.publish(record('P1', [sample('old')]), store.getPaperState('P1'));
  const uncertain = record('P1', [sample('new')]);
  uncertain.verification_status = 'uncertain'; uncertain.revision = 2;
  store.publish(uncertain, store.getPaperState('P1'));
  const page = await call('search_spinel_experiments', { metal_elements: ['Fe', 'Ni'] });
  const ref = page.results.find(x => x.certainty === 'uncertain').record_ref;
  // An uncertain record can be overwritten with the same revision: the timestamp must also be checked.
  store.publish({ ...uncertain, verified_at: '2026-10-03T00:00:00.000Z' }, store.getPaperState('P1'));
  await assert.rejects(call('get_distillation_result', ref), /版本.*重新检索/);
  const newerRef = (await call('search_spinel_experiments', { metal_elements: ['Fe', 'Ni'] })).results.find(x => x.certainty === 'uncertain').record_ref;
  store.publish({ ...record('P1', [sample('final')]), revision: 2 }, store.getPaperState('P1'));
  await assert.rejects(call('get_distillation_result', newerRef), /版本.*重新检索/);
  await assert.rejects(call('get_distillation_result', { paper_id: 'P1', revision: 2 }), /version.*revision.*verified_at/);
  await assert.rejects(call('get_distillation_result', { run_id: 'unused', version: 'verified' }), /run_id/);
});

test('native superset search returns supplementary cases without mixing in exact results', async t => {
  const { store, call } = await fixture(t);
  store.publish(record('P1', [sample('exact')]), store.getPaperState('P1'));
  store.publish(record('P2', [sample('related')], ['Co', 'Fe', 'Ni']), store.getPaperState('P2'));
  const result = await call('search_spinel_experiments', { metal_elements: ['Fe', 'Ni'], match: 'superset' });
  assert.equal(result.match, 'superset');
  assert.equal(result.total, 1);
  assert.equal(result.results[0].sample_id, 'related');
});

test('search without a database returns the same page contract and does not create a database', async t => {
  const { root, call } = await fixture(t);
  const emptyRoot = join(root, 'empty');
  await mkdir(emptyRoot);
  const page = await call('search_spinel_experiments', { metal_elements: ['Ni', 'Fe'], match: 'superset', offset: 10, limit: 3 }, emptyRoot);
  assert.deepEqual(page, {
    metal_elements: ['Fe', 'Ni'], match: 'superset', total: 0, offset: 10, limit: 3,
    has_more: false, next_offset: null, results: [],
    related: { total: 0, uncertain: 0, possible: 0, metal_sets: [] },
  });
  await assert.rejects(stat(join(emptyRoot, 'data/distillation/spina.sqlite')), { code: 'ENOENT' });
});

test('ordering is stable across insertion order and a possible entry never duplicates a confirmed entry', async t => {
  const { store } = await fixture(t);
  const later = record('P2', [sample('b'), sample('a')]);
  later.candidate_match_entries = structuredClone(later.match_entries);
  store.publish(later, store.getPaperState('P2'));
  store.publish(record('P1', [sample('c')]), store.getPaperState('P1'));
  const page = store.searchByElements(['Ni', 'Fe']);
  assert.equal(page.total, 3);
  assert.deepEqual(page.results.map(x => `${x.paper.paper_id}/${x.sample_id}`), ['P1/c', 'P2/a', 'P2/b']);
  assert.ok(page.results.every(x => x.possible === false));
});

test('gap notices follow only the matched sample and its ancestors without treating every empty field as missing', async t => {
  const { store, call } = await fixture(t);
  const r = record('P1', [sample('parent'), sample('child', { shared_from: 'parent' }), sample('sibling')]);
  const gap = (id, message) => ({ sample_local_id: id, field_path: `samples.${id}.method`, issue_type: 'omission',
    current_value: '', source_evidence: [], proposed_correction: message, resolution_status: 'unresolved', affects_matching: false, action: 'source_limit' });
  r.verification.issues = [gap('parent', 'Parent duration missing'), gap('sibling', 'Sibling amount missing')];
  store.publish(r, store.getPaperState('P1'));
  const rows = store.searchByElements(['Fe', 'Ni']).results;
  const child = rows.find(x => x.sample_id === 'child');
  assert.equal(child.missing_information.length, 1);
  assert.equal(child.missing_information[0].sample_id, 'parent');
  assert.equal(child.missing_information[0].message, 'Parent duration missing');
  assert.equal(child.issues, undefined);
  const detail = await call('get_distillation_result', child.record_ref);
  assert.equal(detail.samples.find(x => x.id === 'sibling').missing_information[0].message, 'Sibling amount missing');
  assert.equal(rows.find(x => x.sample_id === 'sibling').missing_information.length, 1);
});

test('a confirmed error cannot be hidden as a gap by a source_limit action', async t => {
  const { store } = await fixture(t);
  const r = record('P1', [sample('s1')]); r.verification_status = 'uncertain';
  r.verification.issues = [{ sample_local_id: 's1', field_path: 'samples.s1.materials.amount', issue_type: 'numeric_error',
    current_value: 'Wrong amount', proposed_correction: 'Correct the amount', source_evidence: [],
    resolution_status: 'confirmed_error', affects_matching: false, action: 'source_limit' }];
  store.publish(r, store.getPaperState('P1'));
  const row = store.searchByElements(['Fe', 'Ni']).results[0];
  assert.equal(row.missing_information, undefined);
  assert.ok(row.issues.some(issue => issue.includes('Correct the amount')));
  assert.equal(row.certainty, 'uncertain');
});

test('a numeric ambiguity in the source is displayed as a source limitation, not an extraction doubt', async t => {
  const { store } = await fixture(t);
  const r = record('P1', [sample('s1')]); r.verification_status = 'uncertain';
  r.verification.issues = [{ sample_local_id: 's1', field_path: 'samples.s1.materials.amount', issue_type: 'numeric_error',
    current_value: 'Disputed amount', proposed_correction: 'The amount cannot yet be established', source_evidence: [],
    resolution_status: 'unresolved', affects_matching: false, action: 'source_limit' }];
  store.publish(r, store.getPaperState('P1'));
  const row = store.searchByElements(['Fe', 'Ni']).results[0];
  assert.equal(row.missing_information, undefined);
  assert.equal(row.issues, undefined);
  assert.ok(row.source_limitations.some(issue => issue.message.includes('cannot yet be established')));
});

test('legacy source limitations are displayed without rewriting the stored version or asserting a new verification', async t => {
  const { store, call } = await fixture(t);
  const r = record('P1', [sample('s1')]); r.verification_status = 'uncertain';
  r.verification.issues = [{ sample_local_id: 's1', field_path: 'samples.s1.steps.time', issue_type: 'source_conflict',
    current_value: 'Two different times', proposed_correction: 'Body and SI report different times', source_evidence: [],
    resolution_status: 'unresolved', affects_matching: false, action: 'source_limit' }];
  r.uncertainties = ['samples.s1.steps.time: Body and SI report different times', 'Selected an earlier checked draft'];
  store.publish(r, store.getPaperState('P1'));
  const before = store.getUncertainPaper('P1');
  const row = (await call('search_spinel_experiments', { metal_elements: ['Fe', 'Ni'] })).results[0];
  assert.equal(row.certainty, 'uncertain'); assert.equal(row.issues, undefined);
  assert.equal(row.source_limitations[0].message, 'Body and SI report different times');
  assert.ok(row.review_notes.includes('Selected an earlier checked draft'));
  const detail = await call('get_distillation_result', row.record_ref);
  assert.deepEqual(detail.issues, []);
  assert.ok(detail.samples[0].source_limitations.length);
  assert.deepEqual(store.getUncertainPaper('P1'), before);
});

test('source conflicts and real extraction errors stay separate in the same legacy record', async t => {
  const { store } = await fixture(t);
  const r = record('P1', [sample('s1')]); r.verification_status = 'uncertain';
  const conflict = { sample_local_id: 's1', field_path: 'samples.s1.steps.time', issue_type: 'source_conflict',
    current_value: 'Different source times', proposed_correction: 'Retain both source times', source_evidence: [],
    resolution_status: 'unresolved', affects_matching: false, action: 'source_limit' };
  r.verification.issues = [conflict, { ...conflict, field_path: 'samples.s1.materials.amount', issue_type: 'numeric_error',
    resolution_status: 'confirmed_error', action: 'repair', proposed_correction: 'An extra zero was introduced by extraction' }];
  store.publish(r, store.getPaperState('P1'));
  const row = store.searchByElements(['Fe', 'Ni']).results[0];
  assert.equal(row.issues.length, 1); assert.match(row.issues[0], /extra zero/);
  assert.equal(row.source_limitations.length, 1); assert.match(row.source_limitations[0].message, /both source/);
});

test('unclassified legacy issues remain readable as review notes without becoming extraction error claims', async t => {
  const { store, call } = await fixture(t);
  const r = record('P1', [sample('s1')]); r.verification_status = 'uncertain';
  r.verification.issues = [{ sample_local_id: 's1', field_path: 'samples.s1.method', issue_type: 'omission',
    current_value: 'Legacy concern', proposed_correction: 'Check the original qualification', source_evidence: [],
    resolution_status: 'unresolved', affects_matching: false }];
  store.publish(r, store.getPaperState('P1'));
  const row = store.searchByElements(['Fe', 'Ni']).results[0];
  assert.equal(row.issues, undefined); assert.match(row.review_notes[0], /original qualification/);
  const detail = await call('get_distillation_result', row.record_ref);
  assert.match(detail.review_notes[0], /original qualification/);
});
