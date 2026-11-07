import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, run, runJson } from './helpers/cli.mjs';

const demoDatabase = resolve(root, 'data/demo/spina.sqlite');
const hashDemo = async () => createHash('sha256').update(await readFile(demoDatabase)).digest('hex');

test('the demo entry point opens the bundled database without writing to it', async t => {
  const before = await hashDemo();
  const beforeStat = await stat(demoDatabase);
  const overview = await run('src/demo.mjs');
  assert.equal(overview.code, 0, overview.stderr);
  assert.match(overview.stdout, /只读/);
  assert.match(overview.stdout, /不调用模型/);
  const after = await hashDemo();
  assert.equal(after, before, '只读演示不得修改数据库内容');
  assert.equal((await stat(demoDatabase)).mtimeMs, beforeStat.mtimeMs);
});

test('deterministic metal search returns paged results with version bindings', async t => {
  const result = await runJson('src/demo.mjs', ['search', '--metals', 'Ni,Co', '--limit', '2', '--json']);
  assert.deepEqual(result.metal_elements, ['Co', 'Ni']);
  assert.equal(result.match, 'exact');
  assert.ok(result.total > 0);
  assert.ok(result.results.length <= 2);
  for (const row of result.results) {
    assert.ok(row.record_ref.paper_id);
    assert.ok(['verified', 'uncertain'].includes(row.record_ref.version));
    assert.equal(typeof row.record_ref.revision, 'number');
  }
  assert.equal(typeof result.related.total, 'number');
});

test('condition filtering works offline and keeps conservative semantics', async t => {
  const result = await runJson('src/demo.mjs', ['conditions', '--temp-max', '400', '--dur-min', '24', '--limit', '2', '--json']);
  assert.match(result.semantics, /字段命中不代表整条配方满足/);
  assert.equal(typeof result.field_matches, 'number');
  assert.equal(typeof result.needs_review, 'number');
  assert.equal(typeof result.unevaluable_samples, 'number');
  assert.ok(result.total >= result.results.length);
});

test('a sample can be expanded and one of its fields traced back to a stored quote', async t => {
  const search = await runJson('src/demo.mjs', ['search', '--metals', 'Ni,Co', '--limit', '1', '--json']);
  const hit = search.results[0];
  const view = await runJson('src/demo.mjs', ['sample', '--paper', hit.paper.paper_id, '--sample', hit.sample_id, '--version', hit.record_ref.version, '--json']);
  assert.equal(view.record_ref.paper_id, hit.paper.paper_id);
  const samples = view.preparation.samples;
  assert.ok(samples.length >= 1);
  const withCondition = samples.flatMap(sample => (sample.steps ?? [])
    .filter(step => (step.conditions ?? []).length)
    .map(step => ({ sample, step }))).find(Boolean);
  assert.ok(withCondition, '演示库样本应至少有一个带条件的步骤');
  const condition = withCondition.step.conditions[0];
  const fieldPath = `samples.${withCondition.sample.local_id}.steps.${withCondition.step.local_id}.conditions.${condition.name}`;
  const evidence = await runJson('src/demo.mjs', ['evidence', '--paper', hit.paper.paper_id, '--sample', hit.sample_id, '--version', hit.record_ref.version, '--field', fieldPath, '--json']);
  assert.equal(evidence.evidence_scope, 'stored_record');
  assert.ok(evidence.fields.length >= 1);
  assert.equal(evidence.fields[0].source_sample_id, withCondition.sample.local_id);
});

test('unknown subcommands and missing filters fail with a readable message', async t => {
  const unknown = await run('src/demo.mjs', ['nonsense']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /未知子命令/);
  const missing = await run('src/demo.mjs', ['search']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--metals/);
  const missingCondition = await run('src/demo.mjs', ['conditions', '--limit', '1']);
  assert.equal(missingCondition.code, 1);
  assert.match(missingCondition.stderr, /至少需要温度、时长或原料/);
});
