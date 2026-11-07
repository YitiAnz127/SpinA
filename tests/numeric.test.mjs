import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuantity, upperBound, lowerBound, programHoldSeconds } from '../src/distillation/numeric.ts';

const fact = (raw, unit = null, status = 'reported') => ({ raw, value: raw, unit, status, evidence: [], note: '' });

test('a single value keeps its original text and canonical value', () => {
  const value = parseQuantity(fact('900 °C'), 'temperature');
  assert.equal(value.kind, 'single');
  assert.equal(value.single, 900);
  assert.equal(value.raw, '900 °C');
  assert.equal(parseQuantity(fact('900 K'), 'temperature').single, 626.85);
});

test('ranges keep both endpoints and never collapse to a midpoint', () => {
  const value = parseQuantity(fact('350–400 °C'), 'temperature');
  assert.equal(value.kind, 'range');
  assert.equal(value.min, 350);
  assert.equal(value.max, 400);
  assert.equal(lowerBound(value), 350);
  assert.equal(upperBound(value), 400);
});

test('one-sided bounds and approximations are distinct kinds', () => {
  const lower = parseQuantity(fact('≥ 400 °C'), 'temperature');
  assert.equal(lower.kind, 'lower');
  assert.equal(lower.min, 400);
  assert.equal(upperBound(lower), null);
  const upper = parseQuantity(fact('≤ 400 °C'), 'temperature');
  assert.equal(upper.kind, 'upper');
  assert.equal(upper.max, 400);
  assert.equal(lowerBound(upper), null);
  const approximate = parseQuantity(fact('about 400 °C'), 'temperature');
  assert.equal(approximate.kind, 'approximate');
  assert.equal(approximate.approximate, 400);
});

test('a temperature programme keeps each stage and its hold', () => {
  const value = parseQuantity(fact('200 °C 1 h → 400 °C 2 h'), 'temperature');
  assert.equal(value.kind, 'program');
  assert.equal(upperBound(value), 400);
  assert.equal(programHoldSeconds(value), 3 * 3600);
  assert.deepEqual(value.program.map(item => item.value), [200, 400]);
});

test('a ramp states the target temperature but leaves the hold unknown', () => {
  const value = parseQuantity(fact('5 °C/min to 400 °C'), 'temperature');
  assert.equal(value.kind, 'program');
  assert.equal(upperBound(value), 400);
  assert.equal(programHoldSeconds(value), null);
});

test('duration units are normalized to seconds, including articles and one-sided bounds', () => {
  assert.equal(parseQuantity(fact('4 h'), 'duration').single, 4 * 3600);
  assert.equal(parseQuantity(fact('30 min'), 'duration').single, 1800);
  assert.equal(parseQuantity(fact('for a day'), 'duration').single, 86400);
  assert.equal(parseQuantity(fact('at least 24 h'), 'duration').min, 86400);
  assert.equal(parseQuantity(fact('at most 2 h'), 'duration').max, 7200);
  assert.equal(parseQuantity(fact('2–4 h'), 'duration').max, 4 * 3600);
});

test('unreported and unparsable values stay unknown instead of getting a default', () => {
  assert.equal(parseQuantity(fact('room temperature'), 'temperature').kind, 'unparsed');
  assert.equal(parseQuantity(fact(null, null, 'not_reported'), 'temperature'), null);
  assert.equal(parseQuantity(fact('a few hours'), 'duration').kind, 'unparsed');
  assert.equal(upperBound(null), null);
});

test('mixed units and negative endpoints are converted independently', () => {
  for (const [raw, type, low, high] of [['1 h–90 min', 'duration', 3600, 5400], ['−20 to −5 °C'.replaceAll('−', '-'), 'temperature', -20, -5]]) {
    const value = parseQuantity(fact(raw), type);
    assert.equal(value.min, low);
    assert.equal(value.max, high);
  }
});
