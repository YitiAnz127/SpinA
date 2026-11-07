import test from 'node:test';
import assert from 'node:assert/strict';
import { numericAnswerMatches } from './numeric-answer.mjs';
test('tiny nonzero scientific answers cannot be replaced by zero', () => {
  assert.equal(numericAnswerMatches(0, 5.91e-10), false);
  assert.equal(numericAnswerMatches(5.91e-10, 5.91e-10), true);
});
test('reference rounding is accepted without accepting large errors', () => {
  assert.equal(numericAnswerMatches(35.2644, 35.3), true);
  assert.equal(numericAnswerMatches(0.74048, 0.74), true);
  assert.equal(numericAnswerMatches(0.70, 0.74), false);
});
test('missing or nonfinite answers do not pass', () => {
  assert.equal(numericAnswerMatches(null, 0), false);
  assert.equal(numericAnswerMatches(NaN, 0), false);
  assert.equal(numericAnswerMatches(Infinity, 1), false);
});
