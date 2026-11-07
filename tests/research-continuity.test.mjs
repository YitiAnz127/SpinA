import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { ResearchStore } from '../src/research/store.ts';
import { sampleFingerprint, checkContinuity, fingerprintDraft } from '../src/research/specimen-identity.ts';
import { checkEvidenceContinuity } from '../src/research/continuity.ts';
import { extractTableObservations, toObservation } from '../src/research/facets/observations.ts';
import { makeRecord, makeSample } from './helpers/research-fixtures.mjs';

const sample = options => makeSample({ id: 'S1', name: 'S1', ...options });

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'research-continuity-'));
  const store = await ResearchStore.openFile(join(directory, 'research.sqlite'));
  t.after(async () => {
    store.close();
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

test('unicode subscripts and spacing do not split one formula into two fingerprints', () => {
  const a = sampleFingerprint(sample({ formula: 'NiCo2O4' }));
  const b = sampleFingerprint(sample({ formula: 'NiCo₂O₄' }));
  assert.equal(a.chemistry_key, b.chemistry_key);
  assert.deepEqual(a.formulas, ['nico2o4']);
});

test('a hyphenated descriptive label is not a different specimen from its plain spelling', () => {
  const hyphen = sampleFingerprint(sample({ formula: 'Ni-Co oxide' }));
  const plain = sampleFingerprint(sample({ formula: 'NiCo oxide' }));
  assert.equal(hyphen.chemistry_key, plain.chemistry_key);
});

test('a variable formula keeps its minus sign, so x and 3-x stay distinct', () => {
  const left = sampleFingerprint(sample({ formula: 'Co_xFe_{3-x}O4' }));
  const right = sampleFingerprint(sample({ formula: 'Co_xFe_{3x}O4' }));
  assert.notEqual(left.chemistry_key, right.chemistry_key);
});

test('the same element set with different stoichiometry is a different specimen', () => {
  const a = sampleFingerprint(sample({ formula: 'NiCo2O4' }));
  const b = sampleFingerprint(sample({ formula: 'Ni2CoO4' }));
  assert.notEqual(a.chemistry_key, b.chemistry_key);
  assert.deepEqual(a.metal_elements, b.metal_elements);
});

test('a fingerprint derives metals from the formula when the stored field is absent', () => {
  const fingerprint = sampleFingerprint(sample({ formula: 'NiFe2O4' }));
  assert.deepEqual(fingerprint.metal_elements, ['Fe', 'Ni']);
});

test('a sample without any reported composition cannot be fingerprinted', () => {
  const bare = sample({ formula: '' });
  bare.phases = [];
  const fingerprint = sampleFingerprint(bare);
  assert.equal(fingerprint.chemistry_key, '');
  assert.equal(checkContinuity(fingerprint, [fingerprint], 'S1').status, 'unverifiable');
});

test('an unchanged sample under a new revision is the same specimen', () => {
  const current = fingerprintDraft(makeRecord({ samples: [sample({ formula: 'NiFe2O4' })] }).draft);
  const check = checkContinuity(current[0], current, 'S1');
  assert.equal(check.status, 'same_specimen');
  assert.equal(check.resolved_sample_id, 'S1');
});

test('a reused sample ID with a different formula is redefined, not reused', () => {
  const before = sampleFingerprint(sample({ formula: 'NiFe2O4' }));
  const after = fingerprintDraft(makeRecord({ samples: [sample({ formula: 'CoFe2O4' })] }).draft);
  const check = checkContinuity(before, after, 'S1');
  assert.equal(check.status, 'redefined');
  assert.match(check.explanation, /化学指纹变化/);
});

test('a renamed sample with matching chemistry is reported as relabelled', () => {
  const before = sampleFingerprint(sample({ formula: 'NiFe2O4' }));
  const after = fingerprintDraft(makeRecord({ samples: [sample({ id: 'S9', formula: 'NiFe2O4' })] }).draft);
  const check = checkContinuity(before, after, 'S1');
  assert.equal(check.status, 'relabelled');
  assert.equal(check.resolved_sample_id, 'S9');
});

test('two samples sharing the chemistry make a missing ID ambiguous instead of guessed', () => {
  const before = sampleFingerprint(sample({ formula: 'NiFe2O4' }));
  const after = fingerprintDraft(makeRecord({ samples: [
    sample({ id: 'A', formula: 'NiFe2O4' }), sample({ id: 'B', formula: 'NiFe2O4' }),
  ] }).draft);
  const check = checkContinuity(before, after, 'S1');
  assert.equal(check.status, 'missing');
  assert.match(check.explanation, /不能自动判断归属/);
});

test('a legacy row without a fingerprint is unverifiable while its sample exists', () => {
  const after = fingerprintDraft(makeRecord({ samples: [sample({ formula: 'NiFe2O4' })] }).draft);
  assert.equal(checkContinuity(null, after, 'S1').status, 'unverifiable');
  assert.equal(checkContinuity(null, after, 'GONE').status, 'missing');
});

const observation = (store, overrides = {}) => {
  store.addObservation({
    observation_id: 'obs-1', paper_id: 'CONT-1', sample_id: 'S1', metric: 'h2_evolution_rate',
    value: 120, unit: 'umol g-1 h-1', method: 'photocatalysis', context: { light_source: '300 W Xe' },
    evidence: [], provenance: 'source_reported',
    record_ref: { paper_id: 'CONT-1', version: 'verified', revision: 1, verified_at: '2026-10-01T00:00:00.000Z' },
    created_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  });
};

const recordAt = (revision, formula, options = {}) => makeRecord({
  paperId: 'CONT-1', revision,
  verifiedAt: revision === 1 ? '2026-10-01T00:00:00.000Z' : '2026-10-05T00:00:00.000Z',
  samples: [sample({ formula, ...options })],
});

test('an observation bound to the current revision is reported as current', async t => {
  const store = await fixture(t);
  const record = recordAt(1, 'NiFe2O4');
  observation(store, { sample_fingerprint: sampleFingerprint(record.draft.samples[0]) });
  const report = checkEvidenceContinuity(record, 'verified', store);
  assert.equal(report.observations[0].status, 'current');
  assert.equal(report.summary.reusable_observations, 1);
  assert.equal(report.summary.needs_revalidation, 0);
});

test('after a re-distillation a surviving sample needs revalidation, not silent reuse', async t => {
  const store = await fixture(t);
  observation(store, { sample_fingerprint: sampleFingerprint(recordAt(1, 'NiFe2O4').draft.samples[0]) });
  const report = checkEvidenceContinuity(recordAt(2, 'NiFe2O4'), 'verified', store);
  assert.equal(report.observations[0].status, 'same_specimen');
  assert.equal(report.observations[0].revision_current, false);
  assert.equal(report.summary.reusable_observations, 0);
  assert.equal(report.summary.needs_revalidation, 1);
});

test('a formula correction under the same ID marks the old observation as orphaned', async t => {
  const store = await fixture(t);
  observation(store, { sample_fingerprint: sampleFingerprint(recordAt(1, 'NiFe2O4').draft.samples[0]) });
  const report = checkEvidenceContinuity(recordAt(2, 'Ni0.5Zn0.5Fe2O4'), 'verified', store);
  assert.equal(report.observations[0].status, 'redefined');
  assert.equal(report.summary.orphaned, 1);
  assert.equal(report.summary.needs_revalidation, 0);
});

test('a relation survives only when both endpoints still mean the same specimen', async t => {
  const store = await fixture(t);
  const base = recordAt(1, 'NiFe2O4');
  store.addSpecimenRelation({
    relation_id: 'rel-1', paper_id: 'CONT-1',
    from_specimen: 'CONT-1::S1', to_specimen: 'CONT-1::S1', relation: 'processed_into',
    evidence: [], note: 'fixture', created_at: '2026-10-01T00:00:00.000Z',
    record_ref: { paper_id: 'CONT-1', version: 'verified', revision: 1, verified_at: '2026-10-01T00:00:00.000Z' },
    fingerprints: { from: sampleFingerprint(base.draft.samples[0]), to: sampleFingerprint(base.draft.samples[0]) },
  });
  const carried = checkEvidenceContinuity(recordAt(2, 'NiFe2O4'), 'verified', store);
  assert.equal(carried.relations[0].reusable, true);
  assert.equal(carried.summary.relations.reusable, 1);

  const changed = checkEvidenceContinuity(recordAt(3, 'CoFe2O4'), 'verified', store);
  assert.equal(changed.relations[0].reusable, false);
  assert.equal(changed.summary.relations.blocked, 1);
});

test('an extracted observation carries the fingerprint of the sample it was matched to', () => {
  const record = makeRecord({ paperId: 'OBS-9', samples: [
    makeSample({ id: 'S1', formula: 'NiCo2O4' }), makeSample({ id: 'S2', formula: 'NiCo2O4' }),
  ] });
  const document = {
    id: 'src_1', path: 'data/paper/fixture.pdf', kind: 'body',
    pages: [{ number: 3, text: 'Photocatalytic H2 evolution under a 300 W Xe lamp.', tables: [{
      bbox: [0, 0, 1, 1], rows: [['Sample', 'H2 evolution rate (umol g-1 h-1)'], ['S1', '120'], ['S2', '180']],
    }] }],
  };
  const extraction = extractTableObservations(record, [document], { metric: 'h2_evolution_rate' });
  assert.equal(extraction.candidates.length, 2);
  const stored = toObservation(extraction.candidates[0]);
  assert.equal(stored.sample_fingerprint.sample_id, 'S1');
  assert.equal(stored.sample_fingerprint.chemistry_key, sampleFingerprint(record.draft.samples[0]).chemistry_key);
});
