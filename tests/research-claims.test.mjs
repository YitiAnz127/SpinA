import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { ResearchStore } from '../src/research/store.ts';
import { explainDisagreement, ingestClaims, validateClaim } from '../src/research/claims.ts';

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'research-claims-'));
  const store = await ResearchStore.openFile(join(directory, 'research.sqlite'));
  t.after(async () => {
    store.close();
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return { store };
}

const claim = (overrides = {}) => ({
  claim_id: 'c1', paper_id: 'P1', topic: 'activity_origin',
  statement: '活性提升来自能带变化', kind: 'author_interpretation', stance: 'positive',
  subject_refs: [{ paper_id: 'P1', sample_id: 'S1', material: 'MnFe2O4' }],
  scope: { composition: 'MnFe2O4', treatment: 'GO composite', measurement: '300 W Xe' },
  support_refs: [{ kind: 'observation', paper_id: 'P1', sample_id: 'S1' }],
  assumptions: [], counter_refs: [], origin_family: 'paper:P1', relations: [], evidence: [],
  ...overrides,
});

test('an observation claim must point at a direct observation or evidence', () => {
  assert.throws(() => validateClaim(claim({ kind: 'author_observation', support_refs: [] })), /必须有直接观察或证据支撑/);
  const valid = validateClaim(claim({ kind: 'author_observation', support_refs: [{ kind: 'evidence', paper_id: 'P1', quote: 'x' }] }));
  assert.equal(valid.kind, 'author_observation');
});

test('a system hypothesis cannot borrow a paper origin', () => {
  assert.throws(() => validateClaim(claim({ kind: 'system_hypothesis', origin_family: 'paper:P1' })), /必须以 system: 开头/);
  const hypothesis = validateClaim(claim({ kind: 'system_hypothesis', origin_family: undefined }));
  assert.match(hypothesis.origin_family, /^system:/);
});

test('claims need a topic, subject and valid relations', () => {
  assert.throws(() => validateClaim(claim({ topic: '' })), /topic/);
  assert.throws(() => validateClaim(claim({ subject_refs: [] })), /subject_ref/);
  assert.throws(() => validateClaim(claim({ relations: [{ type: 'implies', target_claim_id: 'c2' }] })), /relations\[0\]\.type/);
});

test('duplicate claim ids are rejected instead of overwriting silently', async t => {
  const { store } = await fixture(t);
  assert.throws(() => ingestClaims(store, [claim(), claim()]), /claim_id 重复/);
  assert.equal(store.listClaims().length, 0);
});

test('aligned opposite stances across papers are a true conflict', () => {
  const graph = explainDisagreement([
    validateClaim(claim()),
    validateClaim(claim({
      claim_id: 'c2', paper_id: 'P2', stance: 'negative',
      subject_refs: [{ paper_id: 'P2', sample_id: 'S9', material: 'MnFe2O4' }],
      statement: '差异来自比表面积而非能带', origin_family: 'paper:P2',
    })),
  ]);
  const pair = graph.topics[0].pairs[0];
  assert.equal(pair.classification, 'true_conflict');
  assert.ok(pair.aligned.some(item => item.includes('主体')));
  assert.match(pair.explanation, /主体与范围已对齐/);
});

test('a different measurement scope is a mismatch, not a conflict', () => {
  const graph = explainDisagreement([
    validateClaim(claim()),
    validateClaim(claim({
      claim_id: 'c2', paper_id: 'P2', stance: 'negative',
      subject_refs: [{ paper_id: 'P2', sample_id: 'S9', material: 'MnFe2O4' }],
      scope: { composition: 'MnFe2O4', treatment: 'GO composite', measurement: '500 W Xe' },
      origin_family: 'paper:P2',
    })),
  ]);
  const pair = graph.topics[0].pairs[0];
  assert.equal(pair.classification, 'scope_mismatch');
  assert.ok(pair.misaligned.some(item => item.includes('measurement')));
});

test('an observation and an interpretation are an evidence-level difference', () => {
  const graph = explainDisagreement([
    validateClaim(claim()),
    validateClaim(claim({
      claim_id: 'c2', kind: 'author_observation', stance: 'neutral', statement: 'S1 的产氢速率高于对照',
      support_refs: [{ kind: 'observation', paper_id: 'P1', sample_id: 'S1' }],
    })),
  ]);
  assert.equal(graph.topics[0].pairs[0].classification, 'evidence_level_mismatch');
  assert.match(graph.topics[0].pairs[0].explanation, /证据层次不同/);
});

test('a citation is not independent support and not a disagreement', () => {
  const graph = explainDisagreement([
    validateClaim(claim()),
    validateClaim(claim({ claim_id: 'c2', paper_id: 'P3', origin_family: 'paper:P3', support_refs: [], relations: [{ type: 'cites', target_claim_id: 'c1' }] })),
  ]);
  assert.equal(graph.topics[0].pairs[0].classification, 'citation_not_independent');
});

test('different materials are a subject mismatch', () => {
  const graph = explainDisagreement([
    validateClaim(claim()),
    validateClaim(claim({
      claim_id: 'c2', paper_id: 'P2', stance: 'negative',
      subject_refs: [{ paper_id: 'P2', sample_id: 'S9', material: 'ZnFe2O4' }], origin_family: 'paper:P2',
    })),
  ]);
  assert.equal(graph.topics[0].pairs[0].classification, 'subject_mismatch');
});

test('independent support counts unique origins and ignores citations and system hypotheses', () => {
  const graph = explainDisagreement([
    validateClaim(claim()),
    validateClaim(claim({ claim_id: 'c2', paper_id: 'P2', origin_family: 'paper:P2', relations: [{ type: 'supports', target_claim_id: 'c1' }] })),
    validateClaim(claim({ claim_id: 'c3', paper_id: 'P1', origin_family: 'paper:P1', relations: [{ type: 'supports', target_claim_id: 'c1' }] })),
    validateClaim(claim({ claim_id: 'c4', kind: 'system_hypothesis', origin_family: 'system:x', support_refs: [], relations: [{ type: 'supports', target_claim_id: 'c1' }] })),
    validateClaim(claim({ claim_id: 'c5', paper_id: 'P3', origin_family: 'paper:P3', support_refs: [], relations: [{ type: 'cites', target_claim_id: 'c1' }] })),
  ]);
  const support = graph.topics[0].independent_support.find(item => item.claim_id === 'c1');
  assert.deepEqual(support.origins, ['paper:P1', 'paper:P2']);
  assert.equal(support.count, 2);
  assert.match(support.note, /独立来源/);
});

test('a claim without a topic is reported as unpairable instead of guessed', () => {
  // Validation rejects an empty topic; the analyzer still defends against legacy or imported rows.
  const graph = explainDisagreement([{ ...validateClaim(claim()), topic: '' }]);
  assert.equal(graph.topics.length, 0);
  assert.ok(graph.unresolved.some(item => item.includes('没有 topic')));
});

test('claims persist and round-trip through the research store', async t => {
  const { store } = await fixture(t);
  const stored = ingestClaims(store, [claim()]);
  const loaded = store.listClaims('P1');
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], stored[0]);
  assert.equal(store.counts().claims, 1);
});
