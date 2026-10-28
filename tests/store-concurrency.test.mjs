import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { ExperimentStore } from '../src/distillation/store.ts';

const record = (version = 'verified', label = 'initial') => ({
  schema_version: 1, paper: { paper_id: 'CAS', doi: '10.1234/cas', title: 'Concurrency fixture' },
  revision: version === 'verified' ? 1 : 2, verified_at: '2026-10-01T00:00:00.000Z',
  verified_by: 'fixture', verification_status: version, sources: [],
  draft: { assessment: 'original_experiments', samples: [], notes: [label] },
  verification: { source_identity: 'confirmed', coverage: 'complete', samples: [], issues: [], notes: [] },
  match_entries: [],
});
async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'store-concurrency-'));
  const a = await ExperimentStore.open(root), b = await ExperimentStore.open(root);
  t.after(async () => {
    a.close(); b.close(); const rel = relative(base, root);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(root, { recursive: true, force: true });
  });
  return { a, b };
}

test('stale uncertain writes are rejected while the confirmed revision is unchanged', async t => {
  const { a, b } = await fixture(t);
  a.publish(record(), a.getPaperState('CAS'));
  a.publish(record('uncertain'), a.getPaperState('CAS'));
  const stale = a.getPaperState('CAS'), winning = record('uncertain', 'newer');
  // Keep both revision and timestamp equal: the actual record changed nonetheless.
  b.publish(winning, b.getPaperState('CAS'));
  assert.throws(() => a.publish(record('uncertain', 'stale'), stale), /另一个任务更新/);
  assert.deepEqual(a.getUncertainPaper('CAS'), winning);
  assert.equal(a.getPaper('CAS').revision, 1);
});

test('a confirmed publication cannot delete a newer uncertain result it never read', async t => {
  const { a, b } = await fixture(t);
  a.publish(record(), a.getPaperState('CAS'));
  const stale = a.getPaperState('CAS');
  b.publish(record('uncertain', 'newer'), b.getPaperState('CAS'));
  assert.throws(() => a.publish({ ...record(), revision: 2 }, stale), /另一个任务更新/);
  assert.equal(a.getUncertainPaper('CAS').draft.notes[0], 'newer');
});

test('a fresh write succeeds after a conflict and preserves both versions', async t => {
  const { a, b } = await fixture(t);
  const empty = a.getPaperState('CAS');
  b.publish(record(), b.getPaperState('CAS'));
  assert.throws(() => a.publish(record(), empty), /另一个任务更新/);
  a.publish(record('uncertain', 'fresh'), a.getPaperState('CAS'));
  assert.equal(a.getUncertainPaper('CAS').draft.notes[0], 'fresh');
  assert.equal(a.getPaper('CAS').verification_status, 'verified');
});
