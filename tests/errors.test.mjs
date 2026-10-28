import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, SpinaError } from '../src/errors.ts';

test('timeout and user cancellation stay distinct', () => {
  assert.equal(classifyError(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'timeout');
  assert.equal(classifyError(new DOMException('This operation was aborted', 'AbortError')), 'cancelled');
  assert.equal(classifyError(new Error('Request timed out')), 'timeout');
  assert.equal(classifyError({ code: 'ETIMEDOUT' }), 'timeout');
});

test('HTTP errors distinguish quota, timeout, transport, authentication and billing', () => {
  assert.equal(classifyError({ status: 429 }), 'quota');
  assert.equal(classifyError({ status: 503 }), 'network');
  assert.equal(classifyError({ status: 408 }), 'timeout');
  assert.equal(classifyError({ status: 401 }), 'other');
  assert.equal(classifyError({ status: 402 }), 'other');
  assert.equal(classifyError(new Error('fetch failed', { cause: { code: 'ECONNRESET' } })), 'network');
});

test('structure and source failures never masquerade as quota exhaustion', () => {
  assert.equal(classifyError(new SyntaxError('Unexpected token in JSON')), 'structure');
  assert.equal(classifyError('模型输出不符合结构：samples 不完整'), 'structure');
  assert.equal(classifyError('只有 SI，尚缺正文'), 'source');
  assert.equal(classifyError('论文必须是小于 50 MiB 的 PDF 文件'), 'source');
  assert.equal(classifyError('Context limit reached'), 'other');
  assert.equal(classifyError('You have hit your ChatGPT usage limit. Try again in ~12 min.'), 'quota');
});

test('localized typed failures retain their category', () => {
  assert.equal(classifyError(new SpinaError('timeout', '核验请求超过等待时限')), 'timeout');
  assert.equal(classifyError({ message: '已结束', error_kind: 'source' }), 'source');
});
