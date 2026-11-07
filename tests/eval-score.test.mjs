import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { root, run, runJson } from './helpers/cli.mjs';

async function fixture(t) {
  const base = resolve(root, '.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'eval-'));
  t.after(async () => {
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('the frozen task set stays self-consistent and covers the five scenarios', async t => {
  const tasks = JSON.parse(await readFile(resolve(root, 'evals/tasks/frozen-20261105.json'), 'utf8'));
  assert.ok(tasks.tasks.length >= 20 && tasks.tasks.length <= 30, '试点规模应为 20–30 题');
  assert.equal(new Set(tasks.tasks.map(task => task.id)).size, tasks.tasks.length);
  const categories = new Set(tasks.tasks.map(task => task.category));
  assert.deepEqual([...categories].sort(), ['comparison', 'conditions', 'edge_cases', 'evidence_chain', 'metal_set']);
  for (const task of tasks.tasks) {
    assert.ok(task.prompt.length > 5, `${task.id} 缺少题面`);
    assert.ok(task.success_criteria.length >= 2, `${task.id} 缺少成功标准`);
    assert.ok(task.severe_errors.length >= 1, `${task.id} 缺少严重错误定义`);
  }
  assert.ok(tasks.protocol.arms.length >= 3, '需要强基线对照');
});

test('scoring separates success, severe errors, cost, time and infrastructure failures', async t => {
  const directory = await fixture(t);
  const resultsPath = join(directory, 'run.json');
  const init = await run('evals/score-tasks.mjs', ['--init', resultsPath]);
  assert.equal(init.code, 0, init.stderr);
  const template = JSON.parse(await readFile(resultsPath, 'utf8'));
  assert.equal(template.tasks.length, 24);
  assert.equal(template.tasks[0].success, null);
  template.run = { label: 'test-run', arm: 'spina', model: 'fixture' };
  template.tasks[0] = { ...template.tasks[0], success: true, severe_factual_errors: 0, source_support: 'full', seconds: 30, cost_usd: 0.02, infra_failure: null };
  template.tasks[1] = { ...template.tasks[1], success: false, severe_factual_errors: 1, source_support: 'partial', seconds: 50, cost_usd: 0.04, infra_failure: null };
  template.tasks[2] = { ...template.tasks[2], success: null, severe_factual_errors: null, source_support: null, seconds: null, cost_usd: null, infra_failure: 'auth_timeout' };
  await writeFile(resultsPath, JSON.stringify(template, null, 2));
  const report = await runJson('evals/score-tasks.mjs', ['--results', resultsPath, '--json']);
  assert.equal(report.summary.planned, 24);
  assert.equal(report.summary.graded, 2);
  assert.equal(report.summary.success.rate, 0.5);
  assert.equal(report.summary.severe_errors.count, 1);
  assert.equal(report.summary.source_support.supported_rate, 1);
  assert.equal(report.summary.time_seconds.median, 40);
  assert.equal(report.summary.cost_usd.total, 0.06);
  assert.equal(report.summary.infra_failures.count, 1);
  assert.equal(report.summary.coverage, Number((3 / 24).toFixed(3)));
});

test('an unknown task id or invalid source support is rejected instead of skewing the score', async t => {
  const directory = await fixture(t);
  const resultsPath = join(directory, 'bad.json');
  await run('evals/score-tasks.mjs', ['--init', resultsPath]);
  const template = JSON.parse(await readFile(resultsPath, 'utf8'));
  template.tasks[0] = { ...template.tasks[0], id: 'NOPE', success: true };
  await writeFile(resultsPath, JSON.stringify(template));
  const unknown = await run('evals/score-tasks.mjs', ['--results', resultsPath]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /未知题目 ID/);
  const fixed = JSON.parse(await readFile(resultsPath, 'utf8'));
  fixed.tasks[0] = { ...fixed.tasks[0], id: 'M01', success: true, source_support: 'great' };
  await writeFile(resultsPath, JSON.stringify(fixed));
  const invalid = await run('evals/score-tasks.mjs', ['--results', resultsPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /source_support/);
});
