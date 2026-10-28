import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDraft } from '../src/distillation/schema.ts';
import { matchingEntries } from '../src/distillation/pipeline.ts';

const evidence = [{ source_id: 'src_1', page: 1, quote: 'NiFe2O4 and Co3O4 spinel phases.' }];
const fact = raw => ({ raw, evidence });
const sample = id => ({ local_id: id, name: id, material_state: 'as_prepared', phases: [
  { local_id: 'wrong', role: 'target_spinel', formula: fact('NiFe2O4'), identity: fact('spinel') },
  { local_id: 'healthy', role: 'target_spinel', formula: fact('Co3O4'), identity: fact('spinel') },
] });
const draft = () => parseDraft(JSON.stringify({ assessment: 'original_experiments', samples: [sample('a'), sample('b')] }));
const issue = fields => ({ sample_local_id: 'a', field_path: 'samples.a.phases.wrong.formula',
  issue_type: 'composition_or_phase_error', current_value: 'NiFe2O4', proposed_correction: 'Wrong sample assignment',
  resolution_status: 'confirmed_error', affects_matching: true, action: 'repair', source_evidence: evidence, ...fields });
const review = issues => ({ source_identity: 'confirmed', coverage: 'complete', notes: [], issues,
  samples: ['a', 'b'].map(sample_local_id => ({ sample_local_id, can_match: true,
    has_confirmed_errors: true, has_unresolved_issues: false, expandable_fields: [], missing_or_uncertain: [] })) });
const ids = entries => entries.map(e => `${e.sample_local_id}/${e.phase_local_id}`);

test('a confirmed matching error excludes only the affected phase from exact and possible entries', () => {
  const d = draft(), before = structuredClone(d), r = review([issue()]);
  for (const possible of [false, true]) {
    assert.deepEqual(ids(matchingEntries(d, r, possible)), ['a/healthy', 'b/wrong', 'b/healthy']);
  }
  assert.deepEqual(d, before);
});

test('indexed issue paths restrict a paper-level matching error to its actual sample and phase', () => {
  const r = review([issue({ sample_local_id: null, field_path: 'samples[0].phases[0].metal_elements' })]);
  assert.deepEqual(ids(matchingEntries(draft(), r, true)), ['a/healthy', 'b/wrong', 'b/healthy']);
});

test('a sample-wide confirmed matching error cannot become a possible match in that sample', () => {
  const r = review([issue({ field_path: 'samples.a.phases' })]);
  assert.deepEqual(ids(matchingEntries(draft(), r, true)), ['b/wrong', 'b/healthy']);
});

test('a real unresolved source limitation remains possible and does not block sibling phases', () => {
  const r = review([issue({ resolution_status: 'unresolved', action: 'source_limit' })]);
  assert.deepEqual(ids(matchingEntries(draft(), r)), ['a/healthy', 'b/wrong', 'b/healthy']);
  assert.deepEqual(ids(matchingEntries(draft(), r, true)), ['a/wrong', 'a/healthy', 'b/wrong', 'b/healthy']);
});

test('a resolved matching issue does not exclude its former candidate', () => {
  const r = review([issue({ resolution_status: 'resolved' })]);
  assert.equal(matchingEntries(draft(), r, true).length, 4);
});
