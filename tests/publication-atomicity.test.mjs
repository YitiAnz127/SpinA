import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { ExperimentStore } from '../src/distillation/store.ts';

const record = status => ({ schema_version: 1, paper: { paper_id: 'ATOMIC', doi: '10.1234/atomic', title: 'Fixture' },
  revision: 1, verified_at: '2026-10-28T00:00:00.000Z', verified_by: 'fixture', verification_status: status,
  sources: [], draft: { assessment: 'original_experiments', samples: [], notes: [] }, match_entries: [],
  verification: { source_identity: 'confirmed', coverage: 'complete', samples: [], issues: [], notes: [] } });
async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'publication-atomicity-')), store = await ExperimentStore.open(root);
  const db = new DatabaseSync(resolve(root, 'data/distillation/spina.sqlite'));
  t.after(async () => {
    db.close(); store.close(); const rel = relative(base, root);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(root, { recursive: true, force: true });
  });
  return { store, db };
}

for (const version of ['verified', 'uncertain']) test(`${version} publication commits its run terminal state`, async t => {
  const { store } = await fixture(t), run = store.createRun('ATOMIC');
  const done = { ...run, status: version === 'verified' ? 'published' : 'published_uncertain', message: 'Committed' };
  store.publish(record(version), store.getPaperState('ATOMIC'), done);
  assert.equal(store.getRun(run.run_id).status, done.status);
  assert.equal(store.getRun(run.run_id).message, 'Committed');
  assert.equal(store.getPaper('ATOMIC').verification_status, version);
});

test('a terminal-state write failure rolls back publication and preserves the older uncertain version', async t => {
  const { store, db } = await fixture(t);
  store.publish(record('verified'), store.getPaperState('ATOMIC'));
  store.publish({ ...record('uncertain'), revision: 2 }, store.getPaperState('ATOMIC'));
  const before = store.getPaperState('ATOMIC'), run = store.createRun('ATOMIC');
  db.exec("CREATE TRIGGER reject_terminal BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'fixture run-state failure'); END");
  assert.throws(() => store.publish({ ...record('verified'), revision: 2 }, before,
    { ...run, status: 'published', message: 'Must roll back' }), /fixture run-state failure/);
  assert.deepEqual(store.getPaperState('ATOMIC'), before);
  assert.equal(store.getRun(run.run_id).status, 'running');
});

test('a publication rejects a terminal run belonging to another paper', async t => {
  const { store } = await fixture(t), other = store.createRun('OTHER');
  assert.throws(() => store.publish(record('verified'), store.getPaperState('ATOMIC'),
    { ...other, status: 'published' }), /任务/);
  assert.equal(store.getPaper('ATOMIC'), null);
});
