import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { parseDraft } from '../src/distillation/schema.ts';
import { VerificationAgent, DistillationAgent } from '../src/distillation/agents.ts';
import { runDistillation, matchingEntries } from '../src/distillation/pipeline.ts';
import { ExperimentStore } from '../src/distillation/store.ts';

const paper = { paper_id: 'BOUNDARY-001', doi: '10.1234/boundary', title: 'Synthetic publication boundary' };
const evidence = [{ source_id: 'src_1', page: 1, quote: 'NiFe2O4 spinel.' }];
const sources = [{ id: 'src_1', path: 'data/paper/body.pdf', kind: 'body', pages: [{ number: 1, text: 'NiFe2O4 spinel.' }] }];
const draft = () => parseDraft(JSON.stringify({ assessment: 'original_experiments', samples: [{
  local_id: 'sample', name: 'Sample', material_state: 'as_prepared', phases: [{
    local_id: 'phase', role: 'target_spinel', formula: { raw: 'NiFe2O4', evidence }, identity: { raw: 'spinel', evidence },
  }],
}] }));
const review = () => ({ source_identity: 'confirmed', coverage: 'complete', issues: [], notes: [], samples: [{
  sample_local_id: 'sample', has_confirmed_errors: false, has_unresolved_issues: false, can_match: true,
  expandable_fields: [], missing_or_uncertain: [],
}] });
async function workspace(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'verification-boundary-'));
  t.after(async () => { const rel = relative(base, root); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('follow-up verification recomputes current sample judgments and checks repair regressions', async () => {
  const old = review(); old.samples[0].has_confirmed_errors = true; old.samples[0].can_match = false;
  const agent = new VerificationAgent(async request => {
    const input = JSON.parse(request.input);
    assert.deepEqual(input.previous_verification, old);
    assert.doesNotMatch(request.system + input.focus, /samples 沿用|不寻找新的遗漏|不要新增未被上一轮/);
    assert.match(request.system + input.focus, /重新判断|重新评估/);
    return JSON.stringify(review());
  });
  const current = await agent.verify(paper, sources, draft(), undefined, [], old);
  assert.equal(current.samples[0].has_confirmed_errors, false);
  assert.equal(current.samples[0].can_match, true);
});

test('focused repair instructions describe new samples using the actual compact schema', async () => {
  const agent = new DistillationAgent(async request => {
    assert.doesNotMatch(request.system, /新增样品必须是.*aliases/);
    const sample = { local_id: 'added', name: 'Added', material_state: 'as_prepared', phases: [] };
    return JSON.stringify({ patches: [], add_samples: [sample] });
  });
  const result = await agent.repairFocused(paper, sources, draft(), { repair_round: 1, repair_limit: 3 });
  assert.deepEqual(result.samples.map(s => s.local_id), ['sample', 'added']);
});

test('a stale confirmed-error flag without a current issue cannot become a fallback experiment', async t => {
  const root = await workspace(t), r = review(); r.samples[0].has_confirmed_errors = true;
  const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/body.pdf' }] },
    async request => JSON.stringify(request.stage === 'verify' ? r : draft()), { readSources: async () => sources });
  assert.equal(result.status, 'needs_review');
  const store = await ExperimentStore.openExisting(root);
  try { assert.equal(store.getPaper(paper.paper_id), null); } finally { store.close(); }
});

for (const assessment of ['identity_mismatch', 'no_relevant_experiments', 'insufficient_sources']) {
  test(`${assessment} with invalid sample evidence never publishes searchable experiments`, async t => {
    const root = await workspace(t), d = draft(); d.assessment = assessment;
    d.samples[0].phases[0].formula.evidence = [{ ...evidence[0], page: 99 }];
    await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/body.pdf' }] },
      async () => JSON.stringify(d), { maxRepairs: 0, readSources: async () => sources });
    const store = await ExperimentStore.openExisting(root);
    try {
      assert.equal(store.searchByElements(['Ni', 'Fe']).total, 0);
      assert.equal(store.getPaper(paper.paper_id), null);
    } finally { store.close(); }
  });
}

test('unconfirmed source identity cannot generate even a possible matching entry', () => {
  const r = review(); r.source_identity = 'ambiguous';
  assert.deepEqual(matchingEntries(draft(), r, true), []);
});

test('a source-insufficient draft with usable samples still receives normal verification', async t => {
  const root = await workspace(t), d = draft(); d.assessment = 'insufficient_sources';
  const calls = [];
  const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/body.pdf' }] }, async request => {
    calls.push(request.stage); return JSON.stringify(request.stage === 'verify' ? review() : d);
  }, { maxRepairs: 0, readSources: async () => sources });
  assert.deepEqual(calls, ['distill', 'verify']);
  assert.equal(result.status, 'published');
});

test('a valid non-experiment conclusion is retained as a run outcome without publishing samples', async t => {
  const root = await workspace(t), d = draft(); d.assessment = 'no_relevant_experiments';
  const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/body.pdf' }] },
    async () => JSON.stringify(d), { readSources: async () => sources });
  assert.equal(result.status, 'skipped');
  const store = await ExperimentStore.openExisting(root);
  try {
    assert.equal(store.getRun(result.run_id).status, 'skipped');
    assert.equal(store.getPaper(paper.paper_id), null);
  } finally { store.close(); }
});

test('a publication conflict after the final repair fails cleanly without overwriting the winning version', async t => {
  const root = await workspace(t), input = { ...paper, sources: [{ path: 'data/paper/body.pdf' }] };
  await runDistillation(root, input, async request => JSON.stringify(request.stage === 'verify' ? review() : draft()),
    { readSources: async () => sources });
  const bad = review(); bad.samples[0].has_confirmed_errors = true;
  bad.issues = [{ sample_local_id: 'sample', field_path: 'samples.sample.method', issue_type: 'omission',
    current_value: '', proposed_correction: 'Repair the method', resolution_status: 'confirmed_error',
    action: 'repair', affects_matching: false, source_evidence: evidence }];
  let verifications = 0, winner;
  const result = await runDistillation(root, input, async request => {
    if (request.stage !== 'verify') return JSON.stringify(draft());
    if (++verifications === 4) {
      const concurrent = await ExperimentStore.open(root);
      try {
        winner = { ...concurrent.getPaper(paper.paper_id), verification_status: 'uncertain', revision: 2,
          verified_at: '2026-10-28T00:00:00.000Z', uncertainties: ['Concurrent winning result'] };
        concurrent.publish(winner, concurrent.getPaperState(paper.paper_id));
      } finally { concurrent.close(); }
    }
    return JSON.stringify(bad);
  }, { readSources: async () => sources });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /另一个任务更新/);
  const store = await ExperimentStore.openExisting(root);
  try {
    assert.deepEqual(store.getUncertainPaper(paper.paper_id), winner);
    assert.equal(store.getRun(result.run_id).status, 'failed');
    assert.equal(store.getPaper(paper.paper_id).revision, 1);
  } finally { store.close(); }
});

for (const [kind, error] of [
  ['timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
  ['quota', Object.assign(new Error('DeepSeek HTTP 429'), { status: 429 })],
]) test(`check-only verification preserves a ${kind} failure for batch retry`, async t => {
  const root = await workspace(t);
  const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/body.pdf' }] }, async request => {
    if (request.stage === 'verify') throw error;
    return JSON.stringify(draft());
  }, { maxRepairs: 0, readSources: async () => sources });
  assert.equal(result.status, 'failed');
  assert.equal(result.error_kind, kind);
  const store = await ExperimentStore.openExisting(root);
  try {
    assert.equal(store.getRun(result.run_id).error_kind, kind);
    assert.equal(store.getPaper(paper.paper_id), null);
  } finally { store.close(); }
});

test('user cancellation is persisted separately from a timeout', async t => {
  const root = await workspace(t), controller = new AbortController();
  const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/body.pdf' }] }, async () => {
    controller.abort(); controller.signal.throwIfAborted();
  }, { signal: controller.signal, readSources: async () => sources });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error_kind, 'cancelled');
});

test('malformed first extraction output retains a non-retryable structure category', async t => {
  const root = await workspace(t);
  const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/body.pdf' }] },
    async () => '{invalid JSON', { maxRepairs: 0, readSources: async () => sources });
  assert.equal(result.status, 'failed');
  assert.equal(result.error_kind, 'structure');
});
