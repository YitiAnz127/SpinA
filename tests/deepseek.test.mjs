import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createDeepSeekCall, deepSeekConfig, routeDistillationCalls } from '../src/distillation/deepseek.ts';

const config = { apiKey: 'fixture-secret', model: 'deepseek-flash', effort: 'high', repairEffort: 'max' };
const request = { stage: 'distill', system: 'Return JSON.', input: '{"sources":[]}' };
const payload = (content = '{"samples":[]}', finish_reason = 'stop') => ({
  model: 'deepseek-flash', usage: { total_tokens: 42 },
  choices: [{ finish_reason, message: { content, reasoning_content: 'internal reasoning, never an artifact' } }],
});

test('DeepSeek sends official JSON + high thinking, returns only final content and safe usage metadata', async () => {
  let metadata;
  const call = createDeepSeekCall(process.cwd(), config, { onResult: value => { metadata = value; }, fetch: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'high');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[1].content, request.input);
    assert.equal(body.stream, false);
    return Response.json(payload());
  } });
  assert.equal(await call(request), '{"samples":[]}');
  assert.equal(metadata.reasoning, 'high');
  assert.equal(metadata.usage.total_tokens, 42);
  assert.doesNotMatch(JSON.stringify(metadata), /fixture-secret|internal reasoning/);
});

test('stage routing keeps extraction and repairs in DeepSeek and verification in Pi', async () => {
  const called = [];
  const call = routeDistillationCalls(async r => { called.push(`deepseek:${r.stage}`); return '{}'; }, async r => { called.push(`pi:${r.stage}`); return '{}'; });
  for (const stage of ['distill', 'verify', 'repair']) await call({ ...request, stage });
  assert.deepEqual(called, ['deepseek:distill', 'pi:verify', 'deepseek:repair']);
});

test('focused repair uses a patch example rather than an incompatible full-draft example', async () => {
  const call = createDeepSeekCall(process.cwd(), config, { fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content, /JSON结构示例：\{"patches":\[\]\}/);
    assert.doesNotMatch(body.messages[0].content, /no_relevant_experiments/);
    return Response.json(payload('{"patches":[]}'));
  } });
  assert.equal(await call({ ...request, stage: 'repair', outputShape: 'patch' }), '{"patches":[]}');
});

test('credentials are required and only supported model/effort settings are accepted', () => {
  assert.throws(() => deepSeekConfig({}, null), /DEEPSEEK_API_KEY/);
  assert.deepEqual(deepSeekConfig({ DEEPSEEK_API_KEY: 'fixture-secret' }), config);
  assert.throws(() => deepSeekConfig({ DEEPSEEK_API_KEY: 'fixture-secret', SPINA_DISTILL_EFFORT: 'medium' }), /medium.*high/);
  assert.throws(() => deepSeekConfig({ DEEPSEEK_API_KEY: 'fixture-secret', SPINA_DISTILL_MODEL: 'arbitrary' }), /SPINA_DISTILL_MODEL/);
});

test('saved Pi credentials can supply the key, with environment variables taking precedence', () => {
  assert.equal(deepSeekConfig({}, 'saved-fixture').apiKey, 'saved-fixture');
  assert.equal(deepSeekConfig({ DEEPSEEK_API_KEY: 'env-fixture' }, 'saved-fixture').apiKey, 'env-fixture');
});

test('PDF page images are passed with source labels as original PNGs', async () => {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'deepseek-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
  try {
    await writeFile(join(root, 'page.png'), png);
    const call = createDeepSeekCall(root, config, { fetch: async (_url, options) => {
      const body = JSON.parse(options.body), blocks = body.messages[1].content;
      assert.match(blocks[1].text, /src_1 第3页/);
      assert.equal(blocks[2].type, 'image_url');
      assert.equal(blocks[2].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
      assert.equal(blocks[2].image_url.detail, 'original');
      return Response.json(payload());
    } });
    await call({ ...request, images: [{ path: 'page.png', source_id: 'src_1', page: 3 }] });
  } finally { assert.ok(root.startsWith(base + sep)); await rm(root, { recursive: true, force: true }); }
});

test('a model without vision cannot silently discard page images', async () => {
  let sent = false;
  const call = createDeepSeekCall(process.cwd(), { ...config, model: 'deepseek-v4-pro' }, { fetch: async () => { sent = true; return Response.json(payload()); } });
  await assert.rejects(call({ ...request, images: [{ path: 'page.png', source_id: 'src_1', page: 1 }] }), /不支持页图/);
  assert.equal(sent, false);
});

test('truncated/empty output and HTTP failures do not become successful JSON or expose raw errors', async () => {
  for (const response of [Response.json(payload('{}', 'length')), Response.json(payload('')), new Response('fixture-secret', { status: 401 }), new Response('fixture-secret', { status: 402 })]) {
    const call = createDeepSeekCall(process.cwd(), config, { fetch: async () => response });
    await assert.rejects(call(request), error => { assert.doesNotMatch(error.message, /fixture-secret/); return true; });
  }
});

test('an already cancelled task does not make an API request', async () => {
  const controller = new AbortController(); controller.abort(); let sent = false;
  const call = createDeepSeekCall(process.cwd(), config, { fetch: async () => { sent = true; return Response.json(payload()); } });
  await assert.rejects(call({ ...request, signal: controller.signal }));
  assert.equal(sent, false);
});
