import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedExtraction, batchModelKey, sameSourceVersions } from '../src/batch-cache.ts';

const versions = [{ path: 'data/paper/body.pdf', size: 12, mtime_ms: 1234, sha256: 'a'.repeat(64) }];
const saved = () => ({ metadata: { provider: 'deepseek', stop_reason: 'stop', model: 'deepseek-flash', reasoning: 'high' }, output: '{"samples":[]}' });

test('a saved draft without a source binding is rejected even when the call cache is absent or empty', () => {
  assert.throws(() => checkedExtraction(saved(), null, versions), /来源/);
  assert.throws(() => checkedExtraction(saved(), { source_versions: versions, requests: [] }, versions), /来源/);
});

test('draft reuse requires an explicit binding or the exact extraction output in a source-bound call cache', () => {
  const draft = saved();
  assert.equal(checkedExtraction({ ...draft, source_versions: versions }, null, versions).output, draft.output);
  const cache = { source_versions: versions, requests: [{ stage: 'distill', ...draft }] };
  assert.equal(checkedExtraction(draft, cache, versions), draft);
  assert.throws(() => checkedExtraction({ ...draft, output: '{"old":true}' }, cache, versions), /来源/);
  assert.throws(() => checkedExtraction(draft, { ...cache, requests: [{ stage: 'repair', ...draft }] }, versions), /来源/);
});

test('changed source bytes cannot reuse an old draft even if size and modification time are identical', () => {
  const changed = [{ ...versions[0], sha256: 'b'.repeat(64) }];
  assert.equal(sameSourceVersions(versions, changed), false);
  assert.throws(() => checkedExtraction({ ...saved(), source_versions: versions }, null, changed), /来源/);
  assert.equal(sameSourceVersions([{ ...versions[0], sha256: undefined }], versions), false);
});

test('repair cache keys follow the actual repair effort independently of extraction effort', () => {
  const config = { model: 'deepseek-flash', effort: 'high', repairEffort: 'max' };
  assert.equal(batchModelKey('distill', 'verifier', config), 'deepseek/deepseek-flash:high');
  assert.equal(batchModelKey('repair', 'verifier', config), 'deepseek/deepseek-flash:max');
  assert.notEqual(batchModelKey('repair', 'verifier', config), batchModelKey('repair', 'verifier', { ...config, repairEffort: 'high' }));
  assert.equal(batchModelKey('verify', 'verifier', config), 'verifier');
});
