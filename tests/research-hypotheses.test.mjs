import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { ResearchStore } from '../src/research/store.ts';
import { identifyDiscriminatingObservations, ingestHypotheses, validateHypothesis } from '../src/research/hypotheses.ts';

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'research-hypotheses-'));
  const store = await ResearchStore.openFile(join(directory, 'research.sqlite'));
  t.after(async () => {
    store.close();
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return { store };
}

const hypothesis = (overrides = {}) => ({
  hypothesis_id: 'h1',
  statement: '差异来自可接触表面积变化',
  explains: ['Mn 含量增加后活性提高'],
  assumptions: ['比表面积测量可比'],
  predicts: [{ observable: 'normalized activity', expected: 'no difference' }],
  falsifiers: [{ observation: 'normalized activity', outcome: 'still higher for Mn-rich' }],
  ...overrides,
});

test('a hypothesis without a falsifier is rejected as unfalsifiable', () => {
  assert.throws(() => validateHypothesis(hypothesis({ falsifiers: [] })), /可反驳条件/);
  assert.throws(() => validateHypothesis(hypothesis({ predicts: [] })), /可观测量/);
  assert.throws(() => validateHypothesis(hypothesis({ explains: [] })), /试图解释的观察/);
});

test('validation keeps only usable predictions and falsifiers', () => {
  const valid = validateHypothesis(hypothesis({
    hypothesis_id: undefined,
    predicts: [{ observable: ' activity ', expected: ' same ' }, { observable: '', expected: 'x' }],
    falsifiers: [{ observation: 'activity', outcome: 'differs' }, { observation: '', outcome: '' }],
  }));
  assert.deepEqual(valid.predicts, [{ observable: 'activity', expected: 'same' }]);
  assert.equal(valid.falsifiers.length, 1);
  assert.match(valid.hypothesis_id, /^hyp_/);
});

test('different expectations on the same observable are discriminating', () => {
  const result = identifyDiscriminatingObservations([
    validateHypothesis(hypothesis()),
    validateHypothesis(hypothesis({ hypothesis_id: 'h2', statement: '差异来自本征活性', predicts: [{ observable: 'normalized activity', expected: 'higher for Mn-rich' }] })),
  ]);
  assert.equal(result.pairs[0].verdict, 'discriminating');
  assert.deepEqual(result.pairs[0].discriminating, ['normalized activity']);
  assert.match(result.pairs[0].explanation, /预期不同/);
  assert.equal(result.per_hypothesis.length, 2);
  assert.match(result.per_hypothesis[0].falsifiers[0], /被削弱或否定/);
});

test('identical expectations and disjoint observables are not discriminating', () => {
  const same = identifyDiscriminatingObservations([
    validateHypothesis(hypothesis()),
    validateHypothesis(hypothesis({ hypothesis_id: 'h2', statement: '另一种机制但同样预期' })),
  ]);
  assert.equal(same.pairs[0].verdict, 'same_expectation');
  assert.deepEqual(same.pairs[0].discriminating, []);
  assert.ok(same.unresolved.some(item => item.includes('现有假设之间没有可区分观察')));

  const disjoint = identifyDiscriminatingObservations([
    validateHypothesis(hypothesis()),
    validateHypothesis(hypothesis({ hypothesis_id: 'h3', predicts: [{ observable: 'surface composition', expected: 'unchanged' }] })),
  ]);
  assert.equal(disjoint.pairs[0].verdict, 'no_shared_observable');
  assert.match(disjoint.pairs[0].explanation, /现有信息不能区分/);
});

test('hypotheses persist without entering paper records', async t => {
  const { store } = await fixture(t);
  const stored = ingestHypotheses(store, [hypothesis(), hypothesis({ hypothesis_id: 'h2', statement: '第二种解释' })]);
  assert.equal(store.counts().hypotheses, 2);
  assert.deepEqual(store.listHypotheses().map(item => item.hypothesis_id).sort(), ['h1', 'h2']);
  assert.equal(stored[0].statement, hypothesis().statement);
  assert.throws(() => ingestHypotheses(store, [hypothesis(), hypothesis()]), /hypothesis_id 重复/);
});
