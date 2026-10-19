import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDistillation } from '../src/distillation/pipeline.ts';
import { ExperimentStore, deliveryRecord } from '../src/distillation/store.ts';
import { compactDraft, parseDraft, applyFocusedRepair } from '../src/distillation/schema.ts';
import { VerificationAgent } from '../src/distillation/agents.ts';

const evidence = { source_id: 'src_1', page: 1, quote: 'Sample A is pure NiFe2O4 spinel.' };
const fact = value => ({ raw: value, value, unit: null, status: value === null ? 'not_reported' : 'reported', evidence: value === null ? [] : [structuredClone(evidence)], note: '' });
const draft = () => ({ assessment: 'original_experiments', notes: [], samples: [{
  local_id: 'sample_a', name: 'A', aliases: [], material_state: 'as_prepared', variables: [],
  nominal_composition: fact('NiFe2O4'), measured_composition: fact(null),
  phases: [{ local_id: 'phase_a', role: 'target_spinel', formula: fact('NiFe2O4'), identity: fact('spinel'), purity: fact('pure') }],
  method: fact(null), materials: [], steps: [], shared_from: null, unresolved_questions: [],
}] });
const review = () => ({ source_identity: 'confirmed', coverage: 'complete', issues: [], notes: [], samples: [{ sample_local_id: 'sample_a', has_confirmed_errors: false, has_unresolved_issues: false, can_match: true, expandable_fields: ['phases'], missing_or_uncertain: ['method'] }] });
const paper = { paper_id: 'TEST-001', doi: '10.1234/test', title: 'Synthetic pipeline fixture' };
const sources = [{ id: 'src_1', path: 'data/paper/test.pdf', kind: 'body', pages: [{ number: 1, text: evidence.quote }] }];

const testDirectory = fileURLToPath(new URL('../.runtime/tests/', import.meta.url));
async function workspace() {
  await mkdir(testDirectory, { recursive: true });
  const root = await mkdtemp(join(testDirectory, 'spina-'));
  await mkdir(join(root, 'data/paper'), { recursive: true });
  return root;
}
async function cleanup(root) {
  assert.ok(resolve(root).startsWith(resolve(testDirectory) + sep));
  await rm(root, { recursive: true, force: true });
}
const fakeReadSources = async () => structuredClone(sources);
const badReview = (count = 1) => {
  const r = review(); r.samples[0].has_confirmed_errors = true; r.samples[0].can_match = false;
  r.issues = Array.from({length:count},(_,index)=>({ sample_local_id:'sample_a',field_path:`samples[0].method.${index}`,issue_type:'unsupported_addition',current_value:'unsupported fixture condition',source_evidence:[structuredClone(evidence)],proposed_correction:'Remove unsupported condition or mark it unknown.',resolution_status:'confirmed_error',affects_matching:false }));
  return r;
};

test('an unresolved repairable issue continues after the first repair instead of publishing early', async () => {
  const root = await workspace(); let repairs = 0;
  try {
    const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, async request => {
      if (request.stage === 'repair') { repairs++; return JSON.stringify(draft()); }
      if (request.stage === 'distill') return JSON.stringify(draft());
      if (repairs === 2) return JSON.stringify(review());
      const r = badReview(); r.samples[0].has_confirmed_errors = false; r.samples[0].has_unresolved_issues = true;
      r.issues[0].resolution_status = 'unresolved'; r.issues[0].action = 'repair';
      return JSON.stringify(r);
    }, { readSources: fakeReadSources });
    assert.equal(repairs, 2); assert.equal(result.status, 'published');
  } finally { await cleanup(root); }
});

test('properly retained source limitations do not cause repeated model repair calls', async () => {
  const root = await workspace(); const calls = [];
  try {
    const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, async request => {
      calls.push(request.stage);
      if (request.stage !== 'verify') return JSON.stringify(draft());
      const r = badReview(); r.samples[0].has_confirmed_errors = false; r.samples[0].has_unresolved_issues = true;
      r.issues[0].resolution_status = 'unresolved'; r.issues[0].action = 'source_limit';
      return JSON.stringify(r);
    }, { readSources: fakeReadSources });
    assert.deepEqual(calls, ['distill', 'verify']); assert.equal(result.status, 'published');
  } finally { await cleanup(root); }
});

test('search attaches only sample and inherited issues instead of broadcasting a sibling limitation', async () => {
  const root = await workspace();
  try {
    const d = draft(); d.samples.push({ ...structuredClone(d.samples[0]), local_id: 'sample_b', name: 'B' });
    const r = badReview(); r.samples[0].has_confirmed_errors = false; r.samples[0].can_match = true; r.samples[0].has_unresolved_issues = true;
    r.samples.push({ ...r.samples[0], sample_local_id: 'sample_b' });
    r.issues[0] = { ...r.issues[0], sample_local_id: 'sample_b', resolution_status: 'confirmed_error', action: 'repair', proposed_correction: 'B-only limit' };
    r.issues.push({ ...r.issues[0], sample_local_id: null, proposed_correction: 'Shared paper limit' });
    await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, async request => JSON.stringify(request.stage === 'verify' ? r : d), { readSources: fakeReadSources });
    const store = await ExperimentStore.openExisting(root), results = store.searchByElements(['Fe', 'Ni']); store.close();
    assert.ok(results.find(row => row.sample_id === 'sample_a').issues.some(issue => issue.includes('Shared paper limit')));
    assert.ok(!results.find(row => row.sample_id === 'sample_a').issues.some(issue => issue.includes('B-only')));
    assert.ok(results.find(row => row.sample_id === 'sample_b').issues.some(issue => issue.includes('B-only')));
  } finally { await cleanup(root); }
});

test('preparation errors do not downgrade a separately confirmed target metal set or its oxyspinel identity', async () => {
  const root = await workspace();
  try {
    const d = draft(); d.samples[0].phases[0].identity = fact('oxyspinel');
    const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, async request => {
      if (request.stage !== 'verify') return JSON.stringify(d);
      const r = badReview(); r.samples[0].can_match = true;
      return JSON.stringify(r);
    }, { readSources: fakeReadSources });
    assert.equal(result.status, 'published_uncertain');
    const store = await ExperimentStore.openExisting(root), record = store.getUncertainPaper(paper.paper_id);
    assert.equal(record.match_entries.length, 1); assert.equal(record.match_entries[0].element_key, 'Fe|Ni');
    assert.equal(store.searchByElements(['Fe', 'Ni'])[0].possible, false); store.close();
  } finally { await cleanup(root); }
});

test('focused patches preserve every unselected sample and field including unknown constraints', () => {
  const d = draft(); d.samples[0].variables = [{ name: 'duration', fact: { ...fact(null), note: 'Do not inherit parent duration.' } }];
  d.samples.push({ ...structuredClone(d.samples[0]), local_id: 'sample_b', name: 'B' });
  const before = structuredClone(d);
  const updated = applyFocusedRepair(JSON.stringify({ patches: [{ sample_local_id: 'sample_a', changes: { method: { raw: 'NiFe2O4', evidence: [evidence] } } }] }), d);
  assert.equal(updated.samples[0].method.raw, 'NiFe2O4');
  const { method: _old, ...oldFields } = before.samples[0], { method: _new, ...newFields } = updated.samples[0];
  assert.deepEqual(newFields, oldFields); assert.deepEqual(updated.samples[1], before.samples[1]); assert.deepEqual(d, before);
  assert.throws(() => applyFocusedRepair(JSON.stringify({ patches: [{ sample_local_id: 'missing', changes: { steps: [] } }] }), d), /未知样品/);
  const template = applyFocusedRepair(JSON.stringify({ patches: [{ sample_local_id: 'sample_a', changes: { name: 'Shared procedure', material_state: 'unspecified' } }] }), d);
  assert.equal(template.samples[0].name, 'Shared procedure'); assert.equal(template.samples[0].material_state, 'unspecified');
  assert.throws(() => applyFocusedRepair(JSON.stringify({ patches: [{ sample_local_id: 'sample_a', changes: { local_id: 'rewritten' } }] }), d), /不符合结构/);
});

test('an empty focused step list cannot silently erase a shared preparation procedure', () => {
  const d = draft(); d.samples[0].steps = [{ local_id: 'prepare', operation: fact('NiFe2O4'), description: fact(null), material_refs: [], conditions: [] }];
  const safe = applyFocusedRepair(JSON.stringify({ patches: [{ sample_local_id: 'sample_a', changes: { steps: [] } }] }), d);
  assert.deepEqual(safe.samples[0].steps, d.samples[0].steps);
  const explicit = applyFocusedRepair(JSON.stringify({ patches: [{ sample_local_id: 'sample_a', clear_steps: true, changes: { steps: [] } }] }), d);
  assert.deepEqual(explicit.samples[0].steps, []);
});

test('reader output does not repeat units solely because their source spacing differs', () => {
  const d = draft(); d.samples[0].materials = [{ local_id: 'koh', role: 'electrolyte', identity: fact('KOH'), amount: fact(null), concentration: { ...fact('40 wt % KOH'), unit: 'wt%' } }];
  const view = deliveryRecord({ paper, sources: [], draft: d, match_entries: [] });
  assert.equal(view.samples[0].materials[0].concentration, '40 wt % KOH');
});

test('reader retains phase interpretation qualifications instead of making inferred evidence look direct', () => {
  const d = draft(); d.samples[0].phases[0].identity.note = 'Author attribution; no separate XRD for this branch.';
  const view = deliveryRecord({ paper, sources: [], draft: d, match_entries: [] });
  assert.equal(view.samples[0].phases[0].identity.note, d.samples[0].phases[0].identity.note);
});

test('focused continuation starts from the latest uncertain draft without another extraction', async () => {
  const root = await workspace();
  try {
    const input = { ...paper, sources: [{ path: 'data/paper/test.pdf' }] };
    await runDistillation(root, input, async request => JSON.stringify(request.stage === 'verify' ? badReview() : draft()), { readSources: fakeReadSources });
    const calls = []; let repaired = false;
    const result = await runDistillation(root, input, async request => {
      calls.push(request.stage);
      if (request.stage === 'verify') return JSON.stringify(repaired ? review() : badReview());
      assert.equal(request.stage, 'repair'); assert.match(request.system, /只返回patches/); repaired = true;
      return JSON.stringify({ patches: [{ sample_local_id: 'sample_a', changes: { method: { raw: 'NiFe2O4', evidence: [evidence] } } }] });
    }, { readSources: fakeReadSources, seedUncertain: true, focusedRepairs: true });
    assert.deepEqual(calls, ['verify', 'repair', 'verify']); assert.equal(result.status, 'published');
    const store = await ExperimentStore.openExisting(root); assert.equal(store.getPaper(paper.paper_id).draft.samples[0].method.raw, 'NiFe2O4'); store.close();
  } finally { await cleanup(root); }
});

test('follow-up feedback uses the remaining focused budget rather than resetting its counter', async () => {
  const root = await workspace();
  try {
    const input = { ...paper, sources: [{ path: 'data/paper/test.pdf' }] };
    // 第一次跑满修正额度仍修不完 → 疑惑版；第二次从疑惑版继续，修正一次后通过
    const broken = () => badReview();
    await runDistillation(root, input, async request => JSON.stringify(request.stage === 'verify' ? broken() : draft()), { readSources: fakeReadSources });
    const calls = []; let verifications = 0;
    const result = await runDistillation(root, input, async request => {
      calls.push(request.stage);
      if (request.stage === 'verify') return JSON.stringify(++verifications === 1 ? broken() : review());
      const feedback = JSON.parse(request.input).feedback;
      assert.equal(feedback.repair_round, 2); assert.equal(feedback.targeted_followup_feedback, 'Separate the confirmed branch.');
      return JSON.stringify({ patches: [{ sample_local_id: 'sample_a', changes: { unresolved_questions: ['Retained source limitation.'] } }] });
    }, { readSources: fakeReadSources, seedUncertain: true, focusedRepairs: true, initialRepairAttempts: 1, requireFeedbackRepair: true, reviewFeedback: 'Separate the confirmed branch.' });
    assert.equal(result.status, 'published'); assert.deepEqual(calls, ['verify', 'repair', 'verify']);
    const store = await ExperimentStore.openExisting(root); assert.equal(store.getPaper(paper.paper_id).repair_rounds, 2); store.close();
  } finally { await cleanup(root); }
});

test('misplaced step and material notes survive parsing and delivery without relaxing other fields', () => {
  const d = compactDraft(draft());
  d.samples[0].steps = [{ local_id: 'mix', operation: { raw: 'mix', evidence: [evidence], note: 'Existing operation limit.' }, note: 'Duration not reported.' }];
  d.samples[0].materials = [{ local_id: 'precursor', identity: { raw: 'NiFe2O4', evidence: [evidence] }, role: 'precursor', note: 'Hydration state not reported.' }];
  const parsed = parseDraft(JSON.stringify(d));
  assert.equal(parsed.samples[0].steps[0].operation.raw, 'mix');
  assert.equal(parsed.samples[0].steps[0].operation.note, 'Existing operation limit.\nDuration not reported.');
  assert.equal(parsed.samples[0].materials[0].identity.note, 'Hydration state not reported.');
  const view = deliveryRecord({ paper, sources: [], draft: parsed, match_entries: [] });
  assert.match(view.samples[0].steps[0].operation.note, /Duration not reported/);
  assert.match(view.samples[0].materials[0].name.note, /Hydration state/);
  d.samples[0].steps[0].unexpected = true;
  assert.throws(() => parseDraft(JSON.stringify(d)), /不符合结构/);
});

test('recovering the third response verifies it without resetting the repair cap or making another repair call', async () => {
  const root = await workspace();
  try {
    const calls = [];
    const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, async request => {
      calls.push(request.stage);
      if (request.stage === 'repair') throw Error('Must not call DeepSeek again');
      return JSON.stringify(request.stage === 'verify' ? badReview() : draft());
    }, { readSources: fakeReadSources, maxRepairs: 3, initialRepairAttempts: 3 });
    assert.equal(result.status, 'published_uncertain');
    assert.deepEqual(calls, ['distill', 'verify']);
    const store = await ExperimentStore.openExisting(root);
    assert.equal(store.getPaper(paper.paper_id).repair_rounds, 3);
    store.close();
  } finally { await cleanup(root); }
});

test('a malformed update enters repair using the existing draft and preserves the initial error as feedback', async () => {
  const root = await workspace();
  try {
    const input = { ...paper, sources: [{ path: 'data/paper/test.pdf' }] };
    await runDistillation(root, input, async request => JSON.stringify(request.stage === 'verify' ? review() : draft()), { readSources: fakeReadSources });
    const calls = [];
    const result = await runDistillation(root, input, async request => {
      calls.push(request.stage);
      if (request.stage === 'distill') return 'bad-json';
      if (request.stage === 'verify') {
        assert.equal(JSON.parse(request.input).previous_review_feedback, 'Check material assignment against the source.');
        return JSON.stringify(review());
      }
      const feedback = JSON.parse(request.input).feedback;
      assert.equal(feedback.repair_round, 1);
      assert.equal(feedback.initial_output_error.response, 'bad-json');
      const updated = draft(); updated.samples[0].name = 'Repaired A';
      return JSON.stringify(updated);
    }, { readSources: fakeReadSources, reviewFeedback: 'Check material assignment against the source.' });
    assert.deepEqual(calls, ['distill', 'verify', 'repair', 'verify']);
    assert.equal(result.status, 'published');
    const store = await ExperimentStore.openExisting(root);
    assert.equal(store.getPaper(paper.paper_id).draft.samples[0].name, 'Repaired A');
    assert.equal(store.getPaper(paper.paper_id).repair_rounds, 1);
    store.close();
  } finally { await cleanup(root); }
});

test('verification feedback automatically reaches repair, and a corrected record publishes early', async () => {
  const root=await workspace();
  try {
    let repairs=0; const calls=[];
    const result=await runDistillation(root,{...paper,sources:[{path:'data/paper/test.pdf'}]},async request=>{
      calls.push(request.stage);
      if(request.stage==='repair'){
        const feedback=JSON.parse(request.input).feedback;
        assert.equal(feedback.repair_round,1);assert.equal(feedback.repair_limit,3);assert.equal(feedback.verification.issues[0].issue_type,'unsupported_addition');
        repairs++;return JSON.stringify(draft());
      }
      return JSON.stringify(request.stage==='verify'?(repairs?review():badReview()):draft());
    },{readSources:fakeReadSources});
    assert.equal(result.status,'published');assert.deepEqual(calls,['distill','verify','repair','verify']);
    const store=await ExperimentStore.open(root);assert.equal(store.getPaper(paper.paper_id).repair_rounds,1);store.close();
  } finally {await cleanup(root);}
});

test('three unsuccessful repairs index an explicitly uncertain record and possible element matches', async () => {
  const root=await workspace();
  try {
    let repairs=0,verifications=0;
    const result=await runDistillation(root,{...paper,sources:[{path:'data/paper/test.pdf'}]},async request=>{
      if(request.stage==='repair'){
        repairs++;const f=JSON.parse(request.input).feedback;assert.equal(f.repair_round,repairs);assert.equal(f.final_round,repairs===3);
        if(repairs===3)assert.match(request.system,/最后一次修正/);
      }
      if(request.stage==='verify'){verifications++;return JSON.stringify(badReview());}
      return JSON.stringify(draft());
    },{readSources:fakeReadSources});
    assert.equal(repairs,3);assert.equal(verifications,4);assert.equal(result.status,'published_uncertain');
    const store=await ExperimentStore.open(root),record=store.getPaper(paper.paper_id);
    assert.equal(record.verification_status,'uncertain');assert.equal(record.repair_rounds,3);
    assert.equal(record.match_entries.length,0);assert.equal(record.candidate_match_entries[0].element_key,'Fe|Ni');
    const found=store.searchByElements(['Ni','Fe']);assert.equal(found.length,1);assert.equal(found[0].certainty,'uncertain');assert.equal(found[0].possible,true);assert.ok(found[0].issues.length);
    assert.deepEqual(store.searchByElements(['Ni','Fe'],false),[]);
    assert.throws(()=>store.searchByElements(['O','Ni']),/金属元素/);store.close();
    const delivered=JSON.parse(await readFile(join(root,'data/distillation/runs',result.run_id,'record.json'),'utf8'));
    assert.equal(delivered.status,'uncertain');assert.ok(delivered.issues.length);assert.deepEqual(delivered.samples[0].phases[0].possible_metals,['Fe','Ni']);
  } finally {await cleanup(root);}
});

test('final delivery selects the best checked revision when later repairs regress', async () => {
  const root=await workspace();
  try {
    let repairs=0;
    const result=await runDistillation(root,{...paper,sources:[{path:'data/paper/test.pdf'}]},async request=>{
      if(request.stage==='verify')return JSON.stringify(badReview(repairs===1?1:3));
      if(request.stage==='repair')repairs++;
      const d=draft();d.samples[0].name=`version_${repairs}`;return JSON.stringify(d);
    },{readSources:fakeReadSources});
    assert.equal(result.status,'published_uncertain');assert.equal(repairs,3);
    const store=await ExperimentStore.open(root);assert.equal(store.getUncertainPaper(paper.paper_id).draft.samples[0].name,'version_1');store.close();
    const selection=JSON.parse(await readFile(join(root,'data/distillation/runs',result.run_id,'selection.json'),'utf8'));assert.equal(selection.selected_round,1);
  } finally {await cleanup(root);}
});

test('malformed repair replies count toward the three-attempt cap without repeating unchanged verification', async () => {
  const root=await workspace();
  try {
    const calls=[];
    const result=await runDistillation(root,{...paper,sources:[{path:'data/paper/test.pdf'}]},async request=>{
      calls.push(request.stage);return request.stage==='repair'?'not JSON':JSON.stringify(request.stage==='verify'?badReview():draft());
    },{readSources:fakeReadSources});
    assert.equal(result.status,'published_uncertain');assert.deepEqual(calls,['distill','verify','repair','repair','repair']);
    const store=await ExperimentStore.open(root);assert.equal(store.getPaper(paper.paper_id).draft.samples.length,1);store.close();
  } finally {await cleanup(root);}
});

test('an uncertain update remains searchable alongside the last confirmed version', async () => {
  const root=await workspace();
  try {
    const input={...paper,sources:[{path:'data/paper/test.pdf'}]};
    await runDistillation(root,input,async request=>JSON.stringify(request.stage==='verify'?review():draft()),{readSources:fakeReadSources});
    const result=await runDistillation(root,input,async request=>JSON.stringify(request.stage==='verify'?badReview():draft()),{readSources:fakeReadSources});
    assert.equal(result.status,'published_uncertain');
    const store=await ExperimentStore.open(root);assert.equal(store.getPaper(paper.paper_id).verification_status,'verified');assert.equal(store.getPaper(paper.paper_id).revision,1);
    assert.equal(store.getUncertainPaper(paper.paper_id).verification_status,'uncertain');assert.deepEqual(store.searchByElements(['Fe','Ni']).map(item=>item.certainty),['verified','uncertain']);store.close();
  } finally {await cleanup(root);}
});

test('unconfirmed source identity cannot enter the uncertain searchable store', async () => {
  const root=await workspace();
  try {
    let repairs=0;
    const result=await runDistillation(root,{...paper,sources:[{path:'data/paper/test.pdf'}]},async request=>{
      if(request.stage==='repair')repairs++;
      if(request.stage==='verify'){const r=badReview();r.source_identity='ambiguous';return JSON.stringify(r);}
      return JSON.stringify(draft());
    },{readSources:fakeReadSources});
    assert.equal(repairs,3);assert.equal(result.status,'needs_review');
    const store=await ExperimentStore.open(root);assert.equal(store.getPaper(paper.paper_id),null);store.close();
  } finally {await cleanup(root);}
});

test('provider-wide questions become notes while short literal quotes remain subject to evidence checks', () => {
  const d = compactDraft(draft());
  d.unresolved_questions = ['External preparation reference is not supplied.'];
  d.samples[0].phases[0].formula.evidence[0].quote = 'NiFe2O4';
  const parsed = parseDraft(JSON.stringify(d));
  assert.deepEqual(parsed.notes, ['External preparation reference is not supplied.']);
  assert.equal(parsed.samples[0].phases[0].formula.evidence[0].quote, 'NiFe2O4');
  d.unexpected = true;
  assert.throws(() => parseDraft(JSON.stringify(d)), /不符合结构/);
});

test('shared root materials are assigned by explicit step references, not copied to every sample', () => {
  const d=compactDraft(draft());
  d.materials=[{local_id:'ni_salt',role:'precursor',identity:{raw:'Ni nitrate',evidence:[evidence]}},{local_id:'cu_salt',role:'precursor',identity:{raw:'Cu nitrate',evidence:[evidence]}}];
  d.samples[0].steps=[{local_id:'mix',operation:{raw:'mixed',evidence:[evidence]},material_refs:['ni_salt']}];
  const parsed=parseDraft(JSON.stringify(d));
  assert.deepEqual(parsed.samples[0].materials.map(material=>material.local_id),['ni_salt']);
  assert.deepEqual(parsed.samples[0].steps[0].material_refs,['ni_salt']);
  d.materials.push(d.materials[0]);
  assert.throws(()=>parseDraft(JSON.stringify(d)),/唯一 ID/);
});

test('publishes with only extraction and verification, and delivers a minimal JSON', async () => {
  const root = await workspace();
  try {
    const requests = [];
    const call = async request => {
      requests.push(request);
      return JSON.stringify(request.stage === 'verify' ? review() : draft());
    };
    const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, call, { readSources: fakeReadSources, modelLabel: 'test-model' });
    assert.equal(result.status, 'published');
    assert.deepEqual(requests.map(request => request.stage), ['distill', 'verify']);
    const extractionInput = JSON.parse(requests[0].input);
    assert.deepEqual(Object.keys(extractionInput).sort(), ['paper', 'sources']);
    const verificationInput = JSON.parse(requests[1].input);
    assert.deepEqual(Object.keys(verificationInput).sort(), ['draft', 'paper', 'reader_view', 'review_notes', 'sources']);
    assert.equal(verificationInput.draft.samples[0].local_id, 'sample_a');
    assert.deepEqual(verificationInput.sources, sources);
    const delivered = JSON.parse(await readFile(join(root, 'data/distillation/runs', result.run_id, 'record.json'), 'utf8'));
    assert.deepEqual(Object.keys(delivered).sort(), ['paper', 'samples', 'sources']);
    assert.deepEqual(delivered.samples[0].phases[0].metals, ['Fe', 'Ni']);
    assert.equal(delivered.samples[0].method, undefined);
    assert.ok(JSON.stringify(delivered).length < JSON.stringify(draft()).length / 2);
    const store = await ExperimentStore.open(root);
    const record = store.getPaper(paper.paper_id);
    assert.equal(record.revision, 1);
    assert.equal(record.match_entries[0].element_key, 'Fe|Ni');
    assert.equal(record.draft.samples[0].method.value, null);
    store.close();
  } finally { await cleanup(root); }
});

test('a failed update preserves the last verified record', async () => {
  const root = await workspace();
  try {
    const good = async request => JSON.stringify(request.stage === 'verify' ? review() : draft());
    const input = { ...paper, sources: [{ path: 'data/paper/test.pdf' }] };
    await runDistillation(root, input, good, { readSources: fakeReadSources, modelLabel: 'test-model' });
    const bad = async request => {
      if (request.stage === 'verify') { const r = review(); r.samples[0].has_confirmed_errors = true; return JSON.stringify(r); }
      return JSON.stringify(draft());
    };
    const result = await runDistillation(root, input, bad, { readSources: fakeReadSources, maxRepairs: 1 });
    assert.equal(result.status, 'needs_review');
    const store = await ExperimentStore.open(root);
    assert.equal(store.getPaper(paper.paper_id).revision, 1);
    store.close();
  } finally { await cleanup(root); }
});

test('accepts compact extraction without irrelevant fields or empty facts', async () => {
  const root = await workspace();
  try {
    const calls = [];
    const call = async request => {
      calls.push(request);
      if (request.stage === 'verify') {
        const r = review(); delete r.notes; delete r.samples[0].expandable_fields; delete r.samples[0].missing_or_uncertain;
        return JSON.stringify(r);
      }
      return JSON.stringify(compactDraft(draft()));
    };
    const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, call, { readSources: fakeReadSources });
    assert.equal(result.status, 'published');
    const modelSchema = JSON.parse(calls[0].system.slice(calls[0].system.lastIndexOf('\n') + 1));
    const sampleFields = modelSchema.properties.samples.items.properties;
    assert.equal(sampleFields.measured_composition, undefined);
    assert.equal(sampleFields.nominal_composition, undefined);
    assert.ok(sampleFields.variables);
    assert.equal(sampleFields.phases.items.properties.purity, undefined);
    assert.equal(JSON.parse(calls[1].input).draft.samples[0].method.status, 'not_reported');
    assert.equal(JSON.parse(calls[1].input).reader_view.samples[0].method, undefined);
  } finally { await cleanup(root); }
});

test('reader output and verifier both retain unknown child overrides and essential procedure notes', async () => {
  const d=draft();
  const child=structuredClone(d.samples[0]);child.local_id='child';child.name='child';child.shared_from='sample_a';
  child.variables=[{name:'H2_reduction_time',fact:{...fact(null),note:'Sample-specific reduction time is not reported.'}},{name:'repetition_number',fact:{...fact(null),note:'The generic 10-cycle recipe is not assigned to this child.'}}];
  d.samples.push(child);
  d.samples[0].steps=[{local_id:'immersion',operation:fact('spinel'),description:{...fact('Sample A'),note:'Reference electrode: Hg/HgO; reference at 25 C, bath at 80 C.'},material_refs:[],conditions:[]}];
  const record={paper,sources:[{id:'src_1',path:'data/paper/test.pdf'}],draft:d,verification:review(),match_entries:[]};
  const output=deliveryRecord(record);
  assert.equal(output.samples[1].variables[0].value.status,'not_reported');
  assert.equal(output.samples[1].variables[1].name,'repetition_number');
  assert.match(output.samples[0].steps[0].text.note,/Hg\/HgO/);
  const agent=new VerificationAgent(async request=>{
    const input=JSON.parse(request.input);
    assert.equal(input.draft.samples[1].variables[0].fact.status,'not_reported');
    assert.equal(input.reader_view.samples[1].variables[0].value.status,'not_reported');
    assert.match(request.system,/reader_view/);assert.match(request.system,/父步骤/);
    return JSON.stringify(review());
  });
  await agent.verify(paper,sources,d);
});

test('compact records retain sample preparation ratios and amount bases without characterization variables', () => {
  const d = draft();
  d.samples[0].variables = [
    { name: 'precursor_molar_ratio', fact: { ...fact('Ni:Fe = 1:2'), note: 'Ni and Fe precursors, molar basis' } },
    { name: 'lattice_constant', fact: fact('8.3 angstrom') },
  ];
  d.samples[0].materials = [{ local_id: 'salt', role: 'precursor', identity: fact('Ni nitrate'), amount: { ...fact('0.4 mol'), note: 'total metal precursors' }, concentration: fact(null) }];
  d.samples[0].unresolved_questions = ['Calcination atmosphere was not reported.'];
  const compact = compactDraft(d);
  assert.deepEqual(compact.samples[0].variables.map(variable => variable.name), ['precursor_molar_ratio']);
  const delivered = deliveryRecord({ paper, sources: [{ id: 'src_1', path: 'data/paper/test.pdf' }], draft: d, verification: review(), match_entries: [] });
  assert.deepEqual(delivered.samples[0].variables, [{ name: 'precursor_molar_ratio', value: { value: 'Ni:Fe = 1:2', note: 'Ni and Fe precursors, molar basis' } }]);
  assert.deepEqual(delivered.samples[0].materials[0].amount, { value: '0.4 mol', note: 'total metal precursors' });
  assert.deepEqual(delivered.samples[0].issues, ['Calcination atmosphere was not reported.']);
});

test('explicit check-only mode stops after two calls without automatic repairs', async () => {
  const root = await workspace();
  try {
    const calls = [];
    const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, async request => {
      calls.push(request.stage);
      if (request.stage === 'verify') { const r = review(); r.samples[0].has_confirmed_errors = true; return JSON.stringify(r); }
      return JSON.stringify(compactDraft(draft()));
    }, { readSources: fakeReadSources, maxRepairs: 0 });
    assert.equal(result.status, 'needs_review');
    assert.deepEqual(calls, ['distill', 'verify']);
  } finally { await cleanup(root); }
});

test('a nonexistent evidence page prevents publication even when the reviewer would approve', async () => {
  const root = await workspace();
  try {
    const call = async request => {
      if (request.stage === 'verify') return JSON.stringify(review());
      const d = draft(); d.samples[0].phases[0].formula.evidence[0].page = 99;
      return JSON.stringify(d);
    };
    const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, call, { readSources: fakeReadSources, maxRepairs: 0 });
    assert.equal(result.status, 'needs_review');
    const store = await ExperimentStore.open(root);
    assert.equal(store.getPaper(paper.paper_id), null);
    store.close();
  } finally { await cleanup(root); }
});

test('OCR discrepancies reach image-aware verification instead of blocking it', async () => {
  const root=await workspace();
  try {
    const calls=[];
    const d=draft(); d.samples[0].phases[0].formula.evidence[0].quote='NiFe2O4 spinel';
    const read=async()=>[{...structuredClone(sources[0]),pages:[{number:1,text:'NiFe204 spinel',image_path:'.runtime/page.png'}]}];
    const result=await runDistillation(root,{...paper,sources:[{path:'data/paper/test.pdf'}]},async request=>{
      calls.push(request.stage);
      if(request.stage==='verify'){
        const input=JSON.parse(request.input);
        assert.ok(input.review_notes.some(note=>note.kind==='quote_mismatch'));
        assert.equal(request.images[0].page,1);
        return JSON.stringify(review());
      }
      return JSON.stringify(d);
    },{readSources:read});
    assert.equal(result.status,'published'); assert.deepEqual(calls,['distill','verify']);
  } finally {await cleanup(root);}
});

test('model-derived recipe values are checked by the verifier and cannot be published unchanged', async () => {
  const root=await workspace();
  try {
    const calls=[],d=draft(); d.samples[0].variables=[{name:'precursor_molar_ratio',fact:{...fact('NiFe2O4'),value:'1:2',status:'derived'}}];
    const result=await runDistillation(root,{...paper,sources:[{path:'data/paper/test.pdf'}]},async request=>{
      calls.push(request.stage);
      if(request.stage==='verify'){assert.ok(JSON.parse(request.input).review_notes.some(note=>note.kind==='derived'));return JSON.stringify(review());}
      return JSON.stringify(d);
    },{readSources:fakeReadSources,maxRepairs:0});
    assert.equal(result.status,'needs_review'); assert.deepEqual(calls,['distill','verify']);
  } finally {await cleanup(root);}
});

test('rejects stale or incomplete per-sample verification', async () => {
  const root = await workspace();
  try {
    const call = async request => {
      if (request.stage === 'verify') { const r = review(); r.samples = []; return JSON.stringify(r); }
      return JSON.stringify(draft());
    };
    const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, call, { readSources: fakeReadSources, maxRepairs: 0 });
    assert.equal(result.status, 'needs_review');
  } finally { await cleanup(root); }
});

test('an unresolved target formula cannot become an exact-match entry', async () => {
  const root = await workspace();
  try {
    const call = async request => {
      if (request.stage === 'verify') return JSON.stringify(review());
      const d = draft(); d.samples[0].phases[0].formula = { ...fact('NiFe2O4'), status: 'ambiguous' };
      return JSON.stringify(d);
    };
    await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, call, { readSources: fakeReadSources });
    const store = await ExperimentStore.open(root);
    const record = store.getPaper(paper.paper_id);
    store.close();
    assert.deepEqual(record.match_entries, []);
  } finally { await cleanup(root); }
});

test('new papers can be updated using their published identity and source manifest', async () => {
  const root = await workspace();
  try {
    const call = async request => JSON.stringify(request.stage === 'verify' ? review() : draft());
    await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, call, { readSources: fakeReadSources });
    const result = await runDistillation(root, { paper_id: paper.paper_id }, call, { readSources: fakeReadSources });
    assert.equal(result.status, 'published');
    const store = await ExperimentStore.open(root);
    const record = store.getPaper(paper.paper_id);
    store.close();
    assert.equal(record.revision, 2);
  } finally { await cleanup(root); }
});

test('cancellation leaves the last published record intact', async () => {
  const root = await workspace();
  try {
    const good = async request => JSON.stringify(request.stage === 'verify' ? review() : draft());
    await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, good, { readSources: fakeReadSources });
    const controller = new AbortController();
    const cancel = async request => { controller.abort(); return JSON.stringify(draft()); };
    const result = await runDistillation(root, { paper_id: paper.paper_id }, cancel, { readSources: fakeReadSources, signal: controller.signal });
    assert.equal(result.status, 'cancelled');
    const store = await ExperimentStore.open(root);
    const record = store.getPaper(paper.paper_id);
    store.close();
    assert.equal(record.revision, 1);
  } finally { await cleanup(root); }
});

test('forged or truncated phase formulas are blocked despite an approving model response', async () => {
  for (const formula of ['CoFe2O4', 'Fe2O4', 'NiFe2O']) {
    const root = await workspace();
    try {
      const call = async request => {
        if (request.stage === 'verify') return JSON.stringify(review());
        const d = draft(); d.samples[0].phases[0].formula.value = formula;
        return JSON.stringify(d);
      };
      const result = await runDistillation(root, { ...paper, sources: [{ path: 'data/paper/test.pdf' }] }, call, { readSources: fakeReadSources, maxRepairs: 0 });
      assert.equal(result.status, 'needs_review', formula);
    } finally { await cleanup(root); }
  }
});
