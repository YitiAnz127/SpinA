import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaRetryDelay } from '../src/batch-retry.mjs';

test('quota retry accepts the actual approximate-minute error returned by ChatGPT', () => {
  assert.equal(quotaRetryDelay('You have hit your ChatGPT usage limit (plus plan). Try again in ~245 min.'), (245 * 60 + 30) * 1000);
  assert.equal(quotaRetryDelay('Try again in ~244 min.'), (244 * 60 + 30) * 1000);
});

test('quota retry preserves seconds and supports hours with the same safety margin', () => {
  assert.equal(quotaRetryDelay('Try again in 12 seconds.'), 42000);
  assert.equal(quotaRetryDelay('Try again in 1.5 hours.'), (1.5 * 3600 + 30) * 1000);
});

test('an unspecified quota delay retains the existing fallback', () => {
  assert.equal(quotaRetryDelay('Usage limit reached'), 5 * 3600000);
});
