import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { ExperimentStore } from '../src/distillation/store.ts';
import { ResearchStore } from '../src/research/store.ts';
import { root, run } from './helpers/cli.mjs';

const fixtureRecord = () => ({
  schema_version: 1,
  paper: { paper_id: 'BK-1', doi: '10.1234/bk', title: 'Backup fixture' },
  revision: 1, verified_at: '2026-10-01T00:00:00.000Z', verified_by: 'fixture',
  sources: [{ id: 'src_1', path: 'data/paper/fixture.pdf', kind: 'body', page_count: 3, empty_text_pages: [] }],
  draft: { assessment: 'original_experiments', notes: [], samples: [{ local_id: 'S1', name: 'NiFe2O4' }, { local_id: 'S2', name: 'CoFe2O4' }] },
  verification: { source_identity: 'confirmed', coverage: 'complete', samples: [], issues: [], notes: [] },
  match_entries: [{ sample_local_id: 'S1', phase_local_id: 'P1', metal_elements: ['Fe', 'Ni'], element_key: 'Fe|Ni', material_state: 'as_prepared' }],
});

async function fixture(t) {
  const base = resolve(root, '.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'backup-'));
  const sourceRoot = join(directory, 'source');
  await mkdir(sourceRoot, { recursive: true });
  const store = await ExperimentStore.open(sourceRoot);
  try { store.publish(fixtureRecord(), store.getPaperState('BK-1')); }
  finally { store.close(); }
  const research = await ResearchStore.open(sourceRoot);
  try {
    research.saveArtifact({
      schema_version: 1, artifact_id: 'mat_fixture', kind: 'material_identity', provenance: 'deterministic_analysis',
      created_at: '2026-10-01T00:00:00.000Z', inputs: [{ paper_id: 'BK-1' }], warnings: [], unresolved: [], data: { formula: 'NiFe2O4' },
    });
  } finally { research.close(); }
  t.after(async () => {
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const database = join(sourceRoot, 'data/distillation/spina.sqlite');
  return { directory, database, relativeDatabase: relative(root, database).split('\\').join('/') };
}

test('a light backup captures a consistent snapshot with counts and digests', async t => {
  const { directory, relativeDatabase } = await fixture(t);
  const output = join(directory, 'light');
  const result = await run('src/backup.mjs', ['--database', relativeDatabase, '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'light');
  assert.equal(manifest.database.counts.papers, 1);
  assert.equal(manifest.database.digest.samples, 2);
  assert.equal(manifest.database.digest.match_entries, 1);
  assert.equal(manifest.database.sha256.length, 64);
  assert.equal(manifest.artifacts.included, false);
  assert.deepEqual(manifest.excluded.includes('.env'), true);
  const verify = await run('src/backup.mjs', ['--verify', output]);
  assert.equal(verify.code, 0, verify.stderr);
  assert.match(verify.stdout, /校验通过/);
});

test('an existing backup directory is never overwritten', async t => {
  const { directory, relativeDatabase } = await fixture(t);
  const output = join(directory, 'fixed');
  assert.equal((await run('src/backup.mjs', ['--database', relativeDatabase, '--output', output])).code, 0);
  const before = await readFile(join(output, 'manifest.json'), 'utf8');
  const second = await run('src/backup.mjs', ['--database', relativeDatabase, '--output', output]);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /不覆盖上一份备份/);
  assert.equal(await readFile(join(output, 'manifest.json'), 'utf8'), before);
});

test('a tampered backup fails verification instead of being restored', async t => {
  const { directory, relativeDatabase } = await fixture(t);
  const output = join(directory, 'tampered');
  assert.equal((await run('src/backup.mjs', ['--database', relativeDatabase, '--output', output])).code, 0);
  const db = new DatabaseSync(join(output, 'spina.sqlite'));
  try { db.exec("UPDATE papers SET record_json = '{}' WHERE paper_id = 'BK-1'"); }
  finally { db.close(); }
  const verify = await run('src/backup.mjs', ['--verify', output]);
  assert.equal(verify.code, 1);
  assert.match(verify.stdout, /摘要不符|计数不符|知识摘要不符/);
  const restore = await run('src/backup.mjs', ['--restore', output, '--to', join(directory, 'restored-bad')]);
  assert.equal(restore.code, 1);
  assert.match(restore.stderr, /拒绝恢复/);
  await assert.rejects(stat(join(directory, 'restored-bad', 'data/distillation/spina.sqlite')), /ENOENT/);
});

test('restoring into an empty directory reproduces the stored knowledge', async t => {
  const { directory, relativeDatabase } = await fixture(t);
  const output = join(directory, 'restore-source');
  assert.equal((await run('src/backup.mjs', ['--database', relativeDatabase, '--output', output])).code, 0);
  const target = join(directory, 'restored');
  const result = await run('src/backup.mjs', ['--restore', output, '--to', target]);
  assert.equal(result.code, 0, result.stderr);
  const restoredDatabase = join(target, 'data/distillation/spina.sqlite');
  const store = await ExperimentStore.openReadOnly(restoredDatabase);
  try {
    const digest = store.digest();
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(digest.sha256, manifest.database.digest.sha256);
    assert.equal(digest.counts.papers, 1);
    assert.equal(digest.samples, 2);
    assert.equal(store.getPaper('BK-1').draft.samples.length, 2);
  } finally { store.close(); }
});

test('restore refuses to overwrite an existing work database without --force', async t => {
  const { directory, relativeDatabase } = await fixture(t);
  const output = join(directory, 'restore-guard');
  assert.equal((await run('src/backup.mjs', ['--database', relativeDatabase, '--output', output])).code, 0);
  const target = join(directory, 'occupied');
  await mkdir(join(target, 'data/distillation'), { recursive: true });
  await writeFile(join(target, 'data/distillation/spina.sqlite'), 'not a database');
  const result = await run('src/backup.mjs', ['--restore', output, '--to', target]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /拒绝覆盖/);
  assert.equal(await readFile(join(target, 'data/distillation/spina.sqlite'), 'utf8'), 'not a database');
});

test('a full package includes the research workspace and restores it', async t => {
  const { directory, relativeDatabase } = await fixture(t);
  const output = join(directory, 'full-with-research');
  const result = await run('src/backup.mjs', ['--database', relativeDatabase, '--output', output, '--full']);
  assert.equal(result.code, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.research.included, true);
  assert.equal(manifest.research.counts.artifacts, 1);
  assert.equal((await run('src/backup.mjs', ['--verify', output])).code, 0);
  const target = join(directory, 'restored-with-research');
  const restored = await run('src/backup.mjs', ['--restore', output, '--to', target]);
  assert.equal(restored.code, 0, restored.stderr);
  const research = await ResearchStore.openFile(join(target, 'data/research/research.sqlite'), true);
  try { assert.equal(research.counts().artifacts, 1); }
  finally { research.close(); }
});

test('a light package stays knowledge-only and does not claim research artifacts', async t => {
  const { directory, relativeDatabase } = await fixture(t);
  const output = join(directory, 'light-only');
  assert.equal((await run('src/backup.mjs', ['--database', relativeDatabase, '--output', output])).code, 0);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.research.included, false);
  await assert.rejects(stat(join(output, 'research.sqlite')), /ENOENT/);
});

test('the recovery drill proves backup, verify, restore and re-verify in one run', async t => {
  const { directory, relativeDatabase } = await fixture(t);
  const result = await run('src/backup.mjs', ['--database', relativeDatabase, '--drill', '--output', join(directory, 'drill-backup')], { timeout: 120000 });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1\/4 备份完成/);
  assert.match(result.stdout, /2\/4 备份校验通过/);
  assert.match(result.stdout, /3\/4 恢复/);
  assert.match(result.stdout, /4\/4 重复校验通过/);
  assert.match(result.stdout, /演练成功/);
  const manifest = JSON.parse(await readFile(join(directory, 'drill-backup', 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'full');
});

test('full backup binds runs to the selected database and requires its inventory on restore', async t => {
  const { directory, database } = await fixture(t);
  const output = join(directory, 'selected');
  await writeFile(join(database, '../runs/from-selected.json'), '{}');
  assert.equal((await run('src/backup.mjs', ['--database', database, '--output', output, '--full'])).code, 0);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.artifacts.files.map(f => f.path), ['runs/from-selected.json']);
  await rm(join(output, 'artifacts.json'));
  assert.equal((await run('src/backup.mjs', ['--restore', output, '--to', join(directory, 'dest')])).code, 1);
  manifest.artifacts.files[0].path = 'runs/../../escaped.json';
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(output, 'artifacts.json'), JSON.stringify({ files: manifest.artifacts.files }));
  const result = await run('src/backup.mjs', ['--restore', output, '--to', join(directory, 'dest')]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /路径无效/);
});
