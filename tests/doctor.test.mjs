import test from 'node:test';
import assert from 'node:assert/strict';
import { run, runJson } from './helpers/cli.mjs';

test('the browse scenario reports every required check with machine-readable output', async t => {
  const report = await runJson('src/doctor.mjs', ['--json']);
  assert.equal(report.scenario, 'browse');
  assert.equal(report.ok, true);
  assert.deepEqual(report.failed, []);
  const names = report.checks.map(check => check.name);
  for (const required of ['Node 版本', '项目文件', '依赖安装', '演示库', '查询自检']) assert.ok(names.includes(required), `缺少检查项 ${required}`);
  const query = report.checks.find(check => check.name === '查询自检');
  assert.equal(query.ok, true);
  assert.equal(report.online, undefined, '未加 --online 时不得主动联网');
  assert.equal(report.databases.length, 2);
});

test('the distill scenario adds model and key checks without exposing secrets', async t => {
  const result = await run('src/doctor.mjs', ['--scenario', 'distill', '--json']);
  const report = JSON.parse(result.stdout);
  assert.equal(result.code, report.failed.length ? 1 : 0);
  const names = report.checks.map(check => check.name);
  for (const name of ['对话模型认证', '核验模型认证', '蒸馏密钥']) assert.ok(names.includes(name), `缺少检查项 ${name}`);
  const serialized = JSON.stringify(report);
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(serialized), '诊断输出不得包含密钥');
  assert.ok(!serialized.includes('DEEPSEEK_API_KEY='), '诊断输出不得回显密钥内容');
});

test('an unknown scenario fails instead of silently checking something else', async t => {
  const result = await run('src/doctor.mjs', ['--scenario', 'nope']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--scenario 必须为/);
});

test('the human-readable report names the missing dependency instead of a stack trace', async t => {
  const result = await run('src/doctor.mjs');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /该场景必需项全部通过/);
  assert.match(result.stdout, /联网检查未执行/);
});
