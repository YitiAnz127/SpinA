import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { root, run, runJson } from './helpers/cli.mjs';

async function fixture(t) {
  const base = resolve(root, '.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'export-'));
  t.after(async () => {
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function sampleOf() {
  const search = await runJson('src/demo.mjs', ['search', '--metals', 'Ni,Co', '--limit', '1', '--json']);
  const hit = search.results[0];
  return { spec: `${hit.paper.paper_id}:${hit.sample_id}:${hit.record_ref.version}`, hit };
}

test('a task-level comparison keeps per-cell attribution and the record binding', async t => {
  const directory = await fixture(t);
  const { spec, hit } = await sampleOf();
  const output = join(directory, 'comparison.md');
  const result = await run('src/export.mjs', ['--database', 'data/demo/spina.sqlite', '--paper', spec, '--format', 'md', '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  const content = await readFile(output, 'utf8');
  assert.match(content, /SpinA 候选样品对照/);
  assert.match(content, new RegExp(hit.paper.paper_id));
  assert.match(content, /record_ref/);
  assert.match(content, /旧文件不会随库更新/);
  assert.match(content, /〔/, '单元格应标注内容归属');
  assert.match(content, new RegExp(`${hit.record_ref.version} 修订 ${hit.record_ref.revision}`));
});

test('CSV and JSON exports expose the same selection with field paths', async t => {
  const directory = await fixture(t);
  const { spec } = await sampleOf();
  const csv = join(directory, 'comparison.csv');
  const jsonOutput = await runJson('src/export.mjs', ['--database', 'data/demo/spina.sqlite', '--paper', spec, '--format', 'json', '--json']);
  assert.equal(jsonOutput.samples.length, 1);
  assert.equal(jsonOutput.samples[0].record_ref.paper_id, spec.split(':')[0]);
  assert.ok(jsonOutput.samples[0].cells.phase.fields.length >= 1);
  assert.ok(jsonOutput.samples[0].cells.phase.fields[0].field_path.startsWith('samples.'));
  const csvResult = await run('src/export.mjs', ['--database', 'data/demo/spina.sqlite', '--paper', spec, '--format', 'csv', '--output', csv]);
  assert.equal(csvResult.code, 0, csvResult.stderr);
  const lines = (await readFile(csv, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /论文 \/ 样品/);
});

test('an existing export file is not overwritten silently', async t => {
  const directory = await fixture(t);
  const { spec } = await sampleOf();
  const output = join(directory, 'fixed.md');
  assert.equal((await run('src/export.mjs', ['--database', 'data/demo/spina.sqlite', '--paper', spec, '--output', output])).code, 0);
  const second = await run('src/export.mjs', ['--database', 'data/demo/spina.sqlite', '--paper', spec, '--output', output]);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /拒绝覆盖/);
});

test('a selection file can carry the query conditions into the export', async t => {
  const directory = await fixture(t);
  const { hit } = await sampleOf();
  const selection = join(directory, 'selection.json');
  await import('node:fs/promises').then(fs => fs.writeFile(selection, JSON.stringify({
    conditions: '金属集合 Ni–Co；退火温度 < 400 °C',
    samples: [{ paper_id: hit.paper.paper_id, sample_id: hit.sample_id, version: hit.record_ref.version }],
  })));
  const output = join(directory, 'selection.md');
  const result = await run('src/export.mjs', ['--database', 'data/demo/spina.sqlite', '--select', selection, '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(output, 'utf8'), /查询条件：金属集合 Ni–Co；退火温度 < 400 °C/);
});

test('unknown samples and missing selections fail with actionable messages', async t => {
  const directory = await fixture(t);
  const missing = await run('src/export.mjs', ['--database', 'data/demo/spina.sqlite', '--paper', 'SPINA-0001:does-not-exist']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /不存在样品/);
  const none = await run('src/export.mjs', []);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /--paper/);
  await stat(directory);
});
