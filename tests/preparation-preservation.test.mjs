import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDraft, compactDraft, applyFocusedRepair } from '../src/distillation/schema.ts';
import { deliveryRecord } from '../src/distillation/store.ts';

const evidence = [{ source_id: 'src_1', page: 1, quote: 'Heat the precursor.' }];
const unknown = note => ({ raw: null, status: 'not_reported', evidence: [], note });
function draft() {
  const result = parseDraft(JSON.stringify({ assessment: 'original_experiments', samples: [{
    local_id: 'child', name: 'Child', material_state: 'as_prepared',
    phases: [{ local_id: 'phase', role: 'target_spinel', identity: { raw: 'spinel', evidence } }],
    variables: [{ name: 'treatment_duration', fact: unknown('Do not inherit the parent duration.') }],
    method: unknown('The external preparation reference is unavailable.'),
    steps: [{ local_id: 'heat', operation: { raw: 'Heat', evidence },
      conditions: [{ name: 'duration', fact: unknown('Sample-specific time was not reported.') }] }],
  }] }));
  result.samples[0].steps[0].description = { raw: 'Heat the precursor.', value: 'Heat the precursor.',
    evidence, unit: null, status: 'reported', note: 'Applies only to this branch.' };
  return result;
}

test('compact drafts retain explicit unknown overrides and essential descriptions', () => {
  const original = draft(), compact = compactDraft(original);
  const restored = parseDraft(JSON.stringify(compact)).samples[0];
  assert.deepEqual(restored.variables, original.samples[0].variables);
  assert.deepEqual(restored.steps[0].conditions, original.samples[0].steps[0].conditions);
  assert.deepEqual(restored.steps[0].description, original.samples[0].steps[0].description);
  assert.deepEqual(restored.method, original.samples[0].method);
});

test('a partial step patch preserves unmodified unknown conditions and description', () => {
  const original = draft();
  const result = applyFocusedRepair(JSON.stringify({ patches: [{ sample_local_id: 'child',
    changes: { steps: [{ local_id: 'heat', material_refs: [] }] } }] }), original);
  assert.deepEqual(result.samples[0], original.samples[0]);
});

test('preparation variables survive unfamiliar names while explicit characterization is excluded', () => {
  const original = draft();
  const names = ['pH_synthesis', 'precursor_amounts', 'series_y_range', 'heating_rate', 'M', 'new_preparation_input'];
  original.samples[0].variables = [...names, 'lattice_constant'].map(name => ({
    name, fact: { raw: '7.5', value: '7.5', status: 'reported', evidence, unit: null, note: '' },
  }));
  assert.deepEqual(compactDraft(original).samples[0].variables.map(v => v.name), names);
  const view = deliveryRecord({ paper: { paper_id: 'TEST', doi: '10.1234/test', title: 'Test' },
    sources: [], draft: original, match_entries: [] });
  assert.deepEqual(view.samples[0].variables.map(v => v.name), names);
});
