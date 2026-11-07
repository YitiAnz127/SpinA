import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { ExperimentStore, deliveryRecord } from '../src/distillation/store.ts';
import {
  applyReview, listReviewIssues, showPaper, resolveField, structuralErrors, pendingRepairs, issueCategory,
} from '../src/distillation/review.ts';

const evidence = (page = 1, quote = 'annealed at 900 °C for 4 h') => [{ source_id: 'src_1', page, quote }];
const fact = (raw, value, unit, status = 'reported', extra = {}) => ({
  raw, value, unit, status, evidence: status === 'reported' ? evidence() : [], note: '', ...extra,
});
const emptyFact = () => ({ raw: null, value: null, unit: null, status: 'not_reported', evidence: [], note: '' });

function fixtureRecord(overrides = {}) {
  return {
    schema_version: 1,
    paper: { paper_id: 'REV-1', doi: '10.1234/rev', title: 'Review fixture' },
    revision: 1,
    verified_at: '2026-10-01T00:00:00.000Z',
    verified_by: 'openai-codex/gpt-6.1-sol:low',
    verification_status: 'uncertain',
    sources: [{ id: 'src_1', path: 'data/paper/fixture.pdf', kind: 'body', page_count: 5, empty_text_pages: [] }],
    draft: {
      assessment: 'original_experiments',
      notes: ['论文级说明'],
      samples: [{
        local_id: 'S1', name: 'NiFe2O4', aliases: [], material_state: 'as_prepared',
        variables: [], nominal_composition: emptyFact(), measured_composition: emptyFact(),
        phases: [{ local_id: 'P1', role: 'target_spinel', formula: fact('NiFe2O4', 'NiFe2O4', null), identity: fact('spinel', 'spinel', null), purity: emptyFact() }],
        method: fact('co-precipitation', 'co-precipitation', null),
        materials: [{ local_id: 'M1', identity: fact('NiO', 'NiO', null), role: 'precursor', amount: fact('1 g', '1 g', 'g'), concentration: emptyFact() }],
        steps: [{
          local_id: 'ST1', operation: fact('annealing', 'annealing', null), description: emptyFact(), material_refs: ['M1'],
          conditions: [{ name: 'temperature', fact: fact('900 °C', '900 °C', '°C') }, { name: 'duration', fact: fact('4 h', '4 h', 'h') }],
        }],
        shared_from: null, unresolved_questions: [],
      }],
    },
    verification: {
      source_identity: 'confirmed', coverage: 'incomplete', notes: [],
      samples: [{ sample_local_id: 'S1', has_confirmed_errors: true, has_unresolved_issues: true, can_match: true, expandable_fields: [], missing_or_uncertain: [] }],
      issues: [
        {
          sample_local_id: 'S1', field_path: 'samples.S1.phases.P1.formula', issue_type: 'composition_or_phase_error',
          current_value: '化学式写作 NiFe2O4', source_evidence: evidence(2, 'NiFe2O4 spinel'),
          proposed_correction: '改为 NiFe2O4 并保留金属集合', resolution_status: 'confirmed_error', affects_matching: true, action: 'repair',
        },
        {
          sample_local_id: 'S1', field_path: 'samples.S1.steps.ST1.conditions.temperature', issue_type: 'source_conflict',
          current_value: '正文 900 °C，SI 表 1 为 850 °C', source_evidence: evidence(3, 'Table S1: 850 °C'),
          proposed_correction: '保留原文冲突，不擅自选定', resolution_status: 'unresolved', affects_matching: false, action: 'source_limit',
        },
      ],
    },
    match_entries: [{ sample_local_id: 'S1', phase_local_id: 'P1', metal_elements: ['Fe', 'Ni'], element_key: 'Fe|Ni', material_state: 'as_prepared' }],
    ...overrides,
  };
}

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'review-'));
  const store = await ExperimentStore.open(root);
  t.after(async () => {
    store.close();
    const rel = relative(base, root);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  });
  store.publish(fixtureRecord(), store.getPaperState('REV-1'));
  const ref = { paper_id: 'REV-1', version: 'uncertain', revision: 1, verified_at: '2026-10-01T00:00:00.000Z' };
  return { store, ref, root };
}

test('issues are grouped into the four review categories with matching first', async t => {
  const { store } = await fixture(t);
  const result = listReviewIssues(store);
  assert.equal(result.total, 2);
  assert.deepEqual(result.rows.map(row => row.category), ['matching', 'source']);
  assert.equal(result.rows[0].category_label, '影响目标相匹配');
  assert.equal(result.rows[0].evidence_available, true);
  assert.equal(issueCategory({ issue_type: 'unit_error', affects_matching: false }), 'value_unit');
  assert.equal(issueCategory({ issue_type: 'step_omission', affects_matching: false }), 'step_attribution');
  assert.equal(listReviewIssues(store, { category: 'source' }).total, 1);
});

test('resolveField accepts scoped and unambiguous unscoped paths only', async t => {
  const { store } = await fixture(t);
  const record = store.getPaper('REV-1', 'uncertain');
  assert.equal(resolveField(record.draft, 'samples.S1.steps.ST1.conditions.temperature').kind, 'step_condition');
  assert.equal(resolveField(record.draft, 'steps.ST1.conditions.temperature').sample_local_id, 'S1');
  assert.equal(resolveField(record.draft, 'phases.P1.formula').kind, 'phase_formula');
  assert.equal(resolveField(record.draft, 'samples'), null);
  assert.equal(resolveField(record.draft, 'samples.S1.steps.MISSING.operation'), null);
});

test('showPaper exposes fields, evidence pages and the version binding', async t => {
  const { store } = await fixture(t);
  const view = showPaper(store, 'REV-1');
  assert.equal(view.record_ref.version, 'uncertain');
  assert.equal(view.samples[0].steps[0].conditions[0].value, '900 °C');
  assert.equal(view.issues[0].resolved_field.sample_local_id, 'S1');
  assert.equal(view.issues[1].evidence[0].page, 3);
  assert.equal(view.missing_information.length, 0);
});

test('a corrected field publishes a new revision and keeps the audit trail', async t => {
  const { store, ref } = await fixture(t);
  const result = applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四', reason: '对照 SI 表 1 核对',
    decisions: [{
      action: 'correct', field_path: 'samples.S1.steps.ST1.conditions.temperature',
      value: '850', unit: '°C', raw: 'annealed at 850 °C for 4 h', reason: 'SI 表 1 为 850 °C',
      evidence: [{ source_id: 'src_1', page: 3, quote: 'annealed at 850 °C for 4 h' }],
    }],
  }, { now: new Date('2026-11-05T10:00:00.000Z') });
  assert.equal(result.applied, true);
  assert.equal(result.published.revision, 2);
  assert.equal(result.published.verified_at, '2026-11-05T10:00:00.000Z');
  assert.equal(result.verification_status, 'uncertain');
  const record = store.getPaper('REV-1', 'uncertain');
  assert.equal(record.revision, 2);
  assert.equal(record.draft.samples[0].steps[0].conditions[0].fact.value, '850');
  assert.equal(record.human_review.reviewer, '李四');
  assert.equal(record.human_review.previous_revision, 1);
  assert.deepEqual(record.human_review.actions.map(action => action.action), ['correct']);
  const audit = store.listReviewActions('REV-1');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].before.value, '900 °C');
  assert.equal(audit[0].after.value, '850');
  assert.deepEqual(audit[0].record_ref, ref);
  assert.equal(audit[0].evidence[0].page, 3);
  const delivered = deliveryRecord(record);
  assert.equal(delivered.human_review.reviewer, '李四');
  assert.equal(delivered.human_review.actions[0].field_path, 'samples.S1.steps.ST1.conditions.temperature');
  assert.equal(delivered.human_review.actions[0].action, 'correct');
});

test('a numeric correction without the source wording is rejected', async t => {
  const { store, ref } = await fixture(t);
  assert.throws(() => applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四', decisions: [{
      action: 'correct', field_path: 'samples.S1.steps.ST1.conditions.temperature', value: '850', unit: '°C', reason: '修正',
      evidence: [{ source_id: 'src_1', page: 3, quote: 'annealed at 850 °C' }],
    }],
  }), /原文表述 raw/);
});

test('confirming a field is recorded without changing its value', async t => {
  const { store, ref } = await fixture(t);
  const result = applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '王五',
    decisions: [{ action: 'confirm', field_path: 'samples.S1.materials.M1.amount', reason: '与原文一致' }],
  });
  assert.equal(result.applied, true);
  const record = store.getPaper('REV-1', 'uncertain');
  assert.equal(record.draft.samples[0].materials[0].amount.value, '1 g');
  assert.equal(store.listReviewActions('REV-1')[0].action, 'confirm');
});

test('a confirmed extraction error cannot be relabelled as a source conflict', async t => {
  const { store, ref } = await fixture(t);
  assert.throws(() => applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四',
    decisions: [{ action: 'keep_conflict', issue_index: 0, reason: '保留' }],
  }), /不能改标为原文冲突/);
});

test('keeping a real source conflict preserves the limitation, and repair requests are queued', async t => {
  const { store, ref } = await fixture(t);
  applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四',
    decisions: [
      { action: 'keep_conflict', issue_index: 1, reason: '正文与 SI 冲突，保留说明' },
      { action: 'request_repair', issue_index: 0, reason: '请按 SI 重抽化学式' },
    ],
  });
  const record = store.getPaper('REV-1', 'uncertain');
  assert.equal(record.verification.issues[1].action, 'source_limit');
  assert.equal(record.verification.issues[1].resolution_status, 'unresolved');
  assert.equal(record.verification.issues[0].action, 'repair');
  assert.deepEqual(pendingRepairs(store).map(item => item.issue_index), [0]);
});

test('a stale record_ref is rejected instead of applying to another revision', async t => {
  const { store, ref } = await fixture(t);
  applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四',
    decisions: [{ action: 'confirm', field_path: 'samples.S1.materials.M1.amount', reason: '核对' }],
  });
  assert.throws(() => applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '王五',
    decisions: [{ action: 'confirm', field_path: 'samples.S1.materials.M1.amount', reason: '核对' }],
  }), /record_ref 与当前库内版本不一致/);
});

test('a concurrent publication during review is refused at commit time', async t => {
  const { store, ref, root } = await fixture(t);
  const other = await ExperimentStore.open(root);
  try {
    other.publish({ ...fixtureRecord(), revision: 2, verified_at: '2026-10-02T00:00:00.000Z' }, other.getPaperState('REV-1'));
  } finally { other.close(); }
  assert.throws(() => applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四',
    decisions: [{ action: 'confirm', field_path: 'samples.S1.materials.M1.amount', reason: '核对' }],
  }), /已被更新|不一致/);
});

test('a confirmed review takes the next revision across both stored versions', async t => {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'review-versions-'));
  const store = await ExperimentStore.open(root);
  t.after(async () => {
    store.close();
    const rel = relative(base, root);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  });
  const source = fixtureRecord();
  store.publish({ ...source, revision: 3, verified_at: '2026-10-03T00:00:00.000Z', verification_status: 'verified',
    verification: { ...source.verification, issues: [] } }, store.getPaperState('REV-1'));
  store.publish({ ...source, revision: 1, verification_status: 'uncertain',
    verification: { ...source.verification, issues: [source.verification.issues[1]] } }, store.getPaperState('REV-1'));
  const ref = { paper_id: 'REV-1', version: 'uncertain', revision: 1, verified_at: source.verified_at };
  const result = applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四', confirm: true,
    decisions: [{ action: 'confirm', field_path: 'samples.S1.materials.M1.amount', reason: '与原文一致' }],
  });
  assert.equal(result.published.revision, 4, '新修订必须高于另一版本的最新修订');
  assert.equal(result.verification_status, 'verified');
  assert.equal(store.getPaper('REV-1', 'verified').revision, 4);
  assert.equal(store.getPaper('REV-1', 'uncertain'), null, '确认入库后应移除待核对版本');
});

test('whole-paper confirmation is blocked while extraction issues remain', async t => {
  const { store, ref } = await fixture(t);
  assert.throws(() => applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四', confirm: true,
    decisions: [{ action: 'confirm', field_path: 'samples.S1.materials.M1.amount', reason: '核对' }],
  }), /仍有 1 条未解决的抽取问题/);
});

test('evidence outside the stored page range fails the pre-publish structure check', async t => {
  const { store, ref } = await fixture(t);
  assert.throws(() => applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四',
    decisions: [{
      action: 'correct', field_path: 'samples.S1.steps.ST1.conditions.temperature',
      value: '850', unit: '°C', raw: 'annealed at 850 °C', reason: '修正',
      evidence: [{ source_id: 'src_1', page: 99, quote: 'annealed at 850 °C' }],
    }],
  }), /页码 99 超出/);
  assert.equal(store.getPaper('REV-1', 'uncertain').revision, 1);
});

test('a failing audit insert rolls back the record update', async t => {
  const { store, ref, root } = await fixture(t);
  const db = new DatabaseSync(resolve(root, 'data/distillation/spina.sqlite'));
  try {
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON review_actions BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    assert.throws(() => applyReview(store, {
      paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四',
      decisions: [{ action: 'confirm', field_path: 'samples.S1.materials.M1.amount', reason: '核对' }],
    }), /fixture audit failure/);
  } finally { db.close(); }
  const record = store.getPaper('REV-1', 'uncertain');
  assert.equal(record.revision, 1);
  assert.equal(record.human_review, undefined);
  assert.equal(store.listReviewActions('REV-1').length, 0);
});

test('dry run reports the change without writing', async t => {
  const { store, ref } = await fixture(t);
  const result = applyReview(store, {
    paper_id: 'REV-1', version: 'uncertain', record_ref: ref, reviewer: '李四', dryRun: true,
    decisions: [{ action: 'confirm', field_path: 'samples.S1.materials.M1.amount', reason: '核对' }],
  }, { dryRun: true });
  assert.equal(result.applied, false);
  assert.equal(store.getPaper('REV-1', 'uncertain').revision, 1);
  assert.equal(store.listReviewActions('REV-1').length, 0);
});

test('structuralErrors catches duplicate ids and dangling material references', async t => {
  const { store } = await fixture(t);
  const record = store.getPaper('REV-1', 'uncertain');
  assert.deepEqual(structuralErrors(record), []);
  const broken = structuredClone(record);
  broken.draft.samples[0].steps[0].material_refs = ['M9'];
  assert.match(structuralErrors(broken).join('；'), /引用了不存在的原料/);
  const duplicated = structuredClone(record);
  duplicated.draft.samples.push(structuredClone(duplicated.draft.samples[0]));
  assert.match(structuralErrors(duplicated).join('；'), /重复样品 ID/);
});
