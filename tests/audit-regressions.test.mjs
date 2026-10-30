import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolvePaper } from '../src/distillation/documents.ts';
import { createDeepSeekCall } from '../src/distillation/deepseek.ts';
import { classifyError } from '../src/errors.ts';
import { saveJson } from '../src/batch-io.mjs';
import { batchRequestKey, compactCallCache } from '../src/batch-cache.ts';
import { parseExtractionPages } from '../src/distillation/pdf-extraction.ts';

test('catalog isolates malformed rows and diagnoses an identifiable entry without DOI', async t => {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const warnings = []; t.mock.method(console, 'warn', message => warnings.push(message));
  await mkdir(resolve(root, 'data/literature'), { recursive: true });
  await writeFile(resolve(root, 'data/literature/selected-500.jsonl'), '\uFEFF' + [
    JSON.stringify({ paper_id: 'GOOD', doi: '10.1234/test', title: 'Test' }),
    '{broken', 'null', JSON.stringify({ paper_id: 'BAD', title: 'Missing DOI' }),
  ].join('\n'));
  const result = await resolvePaper(root, { paper_id: 'GOOD', sources: [{ path: 'data/paper/test.pdf' }] });
  assert.equal(result.paper.doi, '10.1234/test');
  assert.ok(warnings.some(message => /第 2 行/.test(message)));
  await assert.rejects(resolvePaper(root, { paper_id: 'BAD' }), /题录 BAD 缺少有效 DOI/);
});

test('proxy HTML, truncated JSON and invalid envelopes are retryable network failures without body leakage', async () => {
  for (const body of ['<!DOCTYPE html>fixture-secret', '{"choices":', 'null', '{}']) {
    const call = createDeepSeekCall(process.cwd(), { apiKey: 'fixture-secret', model: 'deepseek-flash', effort: 'high', repairEffort: 'max' }, { fetch: async () => new Response(body) });
    await assert.rejects(call({ stage: 'distill', system: 'JSON', input: '{}' }), error => {
      assert.equal(classifyError(error), 'network'); assert.doesNotMatch(error.message, /fixture-secret/); return true;
    });
  }
});

test('atomic batch writes retry temporary locks and clean up after permanent failures', async () => {
  for (const permanent of [false, true]) {
    let attempts = 0, cleaned = false; const waits = [];
    const io = {
      writeFile: async path => assert.match(path, /\.tmp$/),
      rename: async () => { if (++attempts <= (permanent ? 10 : 2)) throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
      rm: async () => { cleaned = true; }, wait: async delay => waits.push(delay),
    };
    if (permanent) await assert.rejects(saveJson('state.json', {}, io), /locked/);
    else await saveJson('state.json', {}, io);
    assert.equal(attempts, permanent ? 4 : 3); assert.equal(cleaned, true);
    assert.deepEqual(waits, permanent ? [100, 200, 400] : [100, 200]);
  }
});

test('legacy cache migration retains provenance and responses but removes repeated prompts and bounds history', () => {
  const requests = Array.from({ length: 40 }, (_, i) => ({ system: 'system', input: String(i), output: String(i), stage: 'distill' }));
  const cache = compactCallCache({ source_versions: ['source'], requests });
  assert.equal(cache.requests.length, 32); assert.deepEqual(cache.source_versions, ['source']);
  assert.equal(cache.requests.at(-1).request_key, batchRequestKey('system', '39'));
  assert.equal(cache.requests.at(-1).output, '39'); assert.equal(cache.requests.at(-1).input, undefined);
  assert.notEqual(batchRequestKey('a\0b', 'c'), batchRequestKey('a', 'b\0c'));
  assert.deepEqual(compactCallCache(cache), cache);
});

test('extraction rejects missing, duplicate and non-numeric page numbers before OCR', () => {
  for (const pages of [null, [], [{ number: '1', text: '' }], [{ number: 2, text: '' }], [{ number: 1, text: '' }, { number: 1, text: '' }]]) {
    assert.throws(() => parseExtractionPages(JSON.stringify(pages)), /结构或连续页码无效/);
  }
  assert.deepEqual(parseExtractionPages('[{"number":1,"text":"text"}]'), [{ number: 1, text: 'text' }]);
});
