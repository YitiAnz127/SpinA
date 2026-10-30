import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const project = fileURLToPath(new URL('../', import.meta.url));
const base = resolve(project, '.runtime/tests');
const exec = promisify(execFile);
async function fixture(t) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'report-'));
  t.after(async () => {
    const rel = relative(base, root); assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\'));
    await rm(root, { recursive: true, force: true });
  });
  const database = resolve(root, 'spina.sqlite');
  await copyFile(resolve(project, 'data/demo/spina.sqlite'), database);
  return { root, database, output: resolve(root, 'output') };
}
async function run(database, output, extra = []) {
  try {
    const result = await exec(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/report.mjs', '--database', database, '--output', output, ...extra], { cwd: project, windowsHide: true });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('report isolates broken JSON, structurally invalid experiments and broken tasks in a real database copy', async t => {
  const { database, output } = await fixture(t), db = new DatabaseSync(database);
  const ids = db.prepare('SELECT paper_id FROM papers ORDER BY paper_id LIMIT 2').all().map(row => row.paper_id);
  const task = db.prepare('SELECT run_id FROM runs LIMIT 1').get().run_id;
  db.prepare('UPDATE papers SET record_json=? WHERE paper_id=?').run('{broken', ids[0]);
  db.prepare('UPDATE papers SET record_json=? WHERE paper_id=?').run(JSON.stringify({ paper: { paper_id: ids[1] }, draft: { samples: null } }), ids[1]);
  db.prepare('UPDATE runs SET state_json=? WHERE run_id=?').run('{broken', task); db.close();
  const result = await run(database, output);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'));
  assert.equal(summary.skipped.length, 3);
  assert.ok(summary.skipped.some(row => row.paper_id === ids[0] && row.version === 'verified'));
  assert.ok(summary.skipped.some(row => row.paper_id === ids[1] && row.reason.includes('结构')));
  assert.ok(summary.skipped.some(row => row.run_id === task && row.table === 'runs'));
  const snapshot = JSON.parse(await readFile(resolve(output, 'records.json'), 'utf8'));
  assert.deepEqual(snapshot.skipped, summary.skipped);
  assert.ok(snapshot.confirmed_records.length > 0);
  assert.ok(snapshot.inventory.filter(row => ids.includes(row.paper_id)).every(row => row.unreadable_versions.includes('verified')));
  const report = await readFile(resolve(output, 'report.md'), 'utf8');
  assert.match(report, /不完整/); assert.ok(report.includes(ids[0])); assert.ok(report.includes(task));
});

test('custom report databases do not silently inherit the project catalog and can explicitly select a catalog', async t => {
  const { root, database, output } = await fixture(t);
  const first = await run(database, output); assert.equal(first.code, 0, first.stderr);
  const snapshot = JSON.parse(await readFile(resolve(output, 'records.json'), 'utf8'));
  assert.equal(snapshot.statistics.catalog_papers, 0); assert.equal(snapshot.source_catalog, null);
  const papers = snapshot.confirmed_records.slice(0, 2).map(record => record.paper);
  const catalog = resolve(root, 'catalog.jsonl'); await writeFile(catalog, papers.map(paper => JSON.stringify(paper)).join('\n'));
  const selected = resolve(root, 'selected');
  const second = await run(database, selected, ['--catalog', catalog]); assert.equal(second.code, 0, second.stderr);
  const chosen = JSON.parse(await readFile(resolve(selected, 'records.json'), 'utf8'));
  assert.equal(chosen.statistics.catalog_papers, 2); assert.equal(chosen.source_catalog, catalog);
});

test('report rejects output escapes before writing files', async t => {
  const { database } = await fixture(t);
  const outside = await run(database, tmpdir());
  assert.equal(outside.code, 1); assert.match(outside.stderr, /输出目录必须位于项目内/);
});

test('report rejects output escapes through directory links', async t => {
  if (process.env.SPINA_TEST_DIRECTORY_LINKS === '0') return t.skip('当前执行环境未允许创建目录链接');
  const { root, database } = await fixture(t);
  const link = resolve(root, 'outside-link');
  try { await symlink(tmpdir(), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('当前执行环境未允许创建目录链接'); throw error; }
  try {
    const linked = await run(database, link);
    assert.equal(linked.code, 1); assert.match(linked.stderr, /输出目录必须位于项目内/);
  } finally { await unlink(link); }
});

test('empty experiment tables produce an empty report, while missing databases and schemas give readable errors', async t => {
  const { root, database, output } = await fixture(t), db = new DatabaseSync(database);
  db.exec('DELETE FROM papers; DELETE FROM uncertain_papers; DELETE FROM runs;'); db.close();
  const empty = await run(database, output); assert.equal(empty.code, 0, empty.stderr);
  assert.equal(JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8')).unique_stored_papers, 0);
  const missing = await run(resolve(root, 'missing.sqlite'), resolve(root, 'missing-output'));
  assert.equal(missing.code, 1); assert.match(missing.stderr, /数据库不存在/); assert.doesNotMatch(missing.stderr, /\n\s+at /);
  const noTables = resolve(root, 'no-tables.sqlite'); new DatabaseSync(noTables).close();
  const schema = await run(noTables, resolve(root, 'schema-output'));
  assert.equal(schema.code, 1); assert.match(schema.stderr, /缺少实验记录表/);
});

test('report never overwrites an existing output directory', async t => {
  const { database, output } = await fixture(t);
  const first = await run(database, output); assert.equal(first.code, 0, first.stderr);
  const before = await stat(resolve(output, 'records.json'));
  const second = await run(database, output);
  assert.equal(second.code, 1); assert.match(second.stderr, /输出目录已存在/); assert.doesNotMatch(second.stderr, /\n\s+at /);
  assert.equal((await stat(resolve(output, 'records.json'))).mtimeMs, before.mtimeMs);
});
