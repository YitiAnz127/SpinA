import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBatchOutput } from '../src/batch-cache.ts';
import { DistillationAgent } from '../src/distillation/agents.ts';
import { parseDraft, compactDraft } from '../src/distillation/schema.ts';

const evidence = [{ source_id: 'src_1', page: 1, quote: 'spinel was prepared' }];
const draft = () => parseDraft(JSON.stringify({ assessment: 'original_experiments', samples: [{
  local_id: 'parent', name: 'Parent', material_state: 'as_prepared', phases: [],
}, {
  local_id: 'child', name: 'Child', material_state: 'as_prepared', shared_from: 'parent', phases: [],
  variables: [{ name: 'duration', fact: { raw: null, evidence: [], status: 'not_reported', note: 'Do not inherit time.' } }],
}] }));

test('batch prevalidation expands a compact baseline before applying a focused patch', () => {
  const input = JSON.stringify({ draft: compactDraft(draft()) });
  assert.doesNotThrow(() => validateBatchOutput({ stage: 'repair', outputShape: 'patch', input }, '{"patches":[]}'));
  assert.throws(() => validateBatchOutput({ stage: 'repair', outputShape: 'patch', input },
    '{"patches":[{"sample_local_id":"missing","changes":{"name":"bad"}}]}'), /未知样品/);
});

test('focused repair passes batch prevalidation without losing unknown child overrides', async () => {
  const original = draft();
  const agent = new DistillationAgent(async request => {
    const output = JSON.stringify({ patches: [{ sample_local_id: 'parent', changes: { method: { raw: 'prepared', evidence } } }] });
    validateBatchOutput(request, output);
    return output;
  });
  const result = await agent.repairFocused({ paper_id: 'P', doi: '10.1234/p', title: 'Fixture' }, [], original,
    { repair_round: 1, repair_limit: 3 });
  assert.equal(result.samples[0].method.raw, 'prepared');
  assert.deepEqual(result.samples[1], original.samples[1]);
});

test('the final focused repair carries the conservative convergence instruction', async () => {
  const agent = new DistillationAgent(async request => {
    assert.match(request.system, /最后一次修正/);
    assert.match(request.system, /无原文明示依据/);
    return '{"patches":[]}';
  });
  await agent.repairFocused({ paper_id: 'P', doi: '10.1234/p', title: 'Fixture' }, [], draft(),
    { repair_round: 3, repair_limit: 3, final_round: true });
});
