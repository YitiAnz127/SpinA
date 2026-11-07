import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { acquireLock, releaseLock, heartbeat, lockStatus, readLock, lockPath } from '../src/batch-lock.mjs';
import { run } from './helpers/cli.mjs';
import { reconcileQueue } from '../src/batch-recover.mjs';

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'batch-lock-'));
  t.after(async () => {
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('a second batch process is refused while the owner is alive', async t => {
  const directory = await fixture(t);
  const first = await acquireLock(directory, { instanceId: 'first', pid: 111, mode: 'distill_and_verify' });
  assert.equal(first.acquired, true);
  const second = await acquireLock(directory, { instanceId: 'second', pid: 222, alive: () => true });
  assert.equal(second.acquired, false);
  assert.equal(second.status.state, 'held');
  assert.equal(second.lock.instance_id, 'first');
  assert.equal((await readLock(directory)).instance_id, 'first');
});

test('a lock whose owner has exited is archived and replaced', async t => {
  const directory = await fixture(t);
  await acquireLock(directory, { instanceId: 'dead', pid: 999999, mode: 'distill_and_verify' });
  const next = await acquireLock(directory, { instanceId: 'next', pid: 222, alive: () => false });
  assert.equal(next.acquired, true);
  assert.equal(next.stale.lock.instance_id, 'dead');
  assert.match(next.stale.reason, /已退出/);
  const archived = JSON.parse(await readFile(`${lockPath(directory)}.stale`, 'utf8'));
  assert.equal(archived.instance_id, 'dead');
  assert.equal(archived.archived_at.length > 0, true);
  assert.equal((await readLock(directory)).instance_id, 'next');
});

test('another host is only presumed dead after its heartbeat expires', async t => {
  const directory = await fixture(t);
  const now = Date.now();
  await acquireLock(directory, { instanceId: 'remote', pid: 333, host: 'other-host', now: new Date(now) });
  const fresh = await acquireLock(directory, { instanceId: 'local', pid: 444, host: 'local-host', now: new Date(now + 60000), alive: () => false });
  assert.equal(fresh.acquired, false);
  assert.equal(fresh.status.state, 'held');
  const expired = await acquireLock(directory, { instanceId: 'local-2', pid: 445, host: 'local-host', now: new Date(now + 31 * 60000), alive: () => false });
  assert.equal(expired.acquired, true);
  assert.match(expired.stale.reason, /心跳已过期/);
});

test('lockStatus reports free, held and stale without touching the file', async t => {
  const directory = await fixture(t);
  assert.deepEqual(lockStatus(null), { state: 'free' });
  const lock = { instance_id: 'x', pid: 1, hostname: 'h', started_at: '2026-01-01T00:00:00.000Z', heartbeat_at: '2026-01-01T00:00:00.000Z' };
  assert.equal(lockStatus(lock, { host: 'h', alive: () => true }).state, 'held');
  assert.equal(lockStatus(lock, { host: 'h', alive: () => false }).state, 'stale');
  assert.equal(lockStatus(lock, { host: 'other', now: Date.parse('2026-01-01T00:05:00.000Z') }).state, 'held');
  assert.equal(lockStatus(lock, { host: 'other', now: Date.parse('2026-02-01T00:00:00.000Z') }).state, 'stale');
});

test('heartbeat stops when the lock was replaced, and release never removes a foreign lock', async t => {
  const directory = await fixture(t);
  const first = await acquireLock(directory, { instanceId: 'first', pid: 111 });
  assert.equal(await heartbeat(directory, first.lock.instance_id), true);
  assert.equal(await heartbeat(directory, 'someone-else'), false);
  // Simulate a replaced lock (stale break by another process).
  await releaseLock(directory, 'first');
  await acquireLock(directory, { instanceId: 'second', pid: 222 });
  assert.equal(await releaseLock(directory, 'first'), false);
  assert.equal((await readLock(directory)).instance_id, 'second');
  assert.equal(await releaseLock(directory, 'second'), true);
  await assert.rejects(stat(lockPath(directory)), /ENOENT/);
});

const queue = () => [
  { paper_id: 'A', status: 'running', run_id: 'run-a' },
  { paper_id: 'B', status: 'claimed' },
  { paper_id: 'C', status: 'published' },
  { paper_id: 'D', status: 'failed', error_kind: 'network', message: 'timeout' },
  { paper_id: 'E', status: 'waiting_for_quota', resume_at: '2026-01-01T00:00:00.000Z' },
  { paper_id: 'F', status: 'waiting_for_quota', resume_at: '2030-01-01T00:00:00.000Z' },
];

test('recovery turns interrupted rows back to pending without losing the run id', () => {
  const original = queue();
  const { queue: next, report } = reconcileQueue(original, { isPublished: () => false, now: Date.parse('2026-06-01T00:00:00.000Z') });
  assert.deepEqual(report.reset_pending.sort(), ['A', 'B', 'E']);
  assert.equal(next.find(item => item.paper_id === 'A').status, 'pending');
  assert.equal(next.find(item => item.paper_id === 'A').run_id, 'run-a');
  assert.equal(next.find(item => item.paper_id === 'F').status, 'waiting_for_quota');
  assert.deepEqual(report.waiting_kept, ['F']);
  // The caller's array is not mutated; a failed write must not corrupt in-memory state.
  assert.equal(original[0].status, 'running');
});

test('a committed transaction wins over a stale queue row', () => {
  const { queue: next, report } = reconcileQueue(queue(), { isPublished: id => id === 'A', now: 0 });
  const a = next.find(item => item.paper_id === 'A');
  assert.equal(a.status, 'already_published');
  assert.match(a.message, /已有发布记录/);
  assert.deepEqual(report.already_published, ['A']);
  assert.ok(report.reset_pending.includes('B'));
});

test('reuse modes still requeue published papers, and artifacts are reported as reusable', () => {
  const { queue: next, report } = reconcileQueue([
    { paper_id: 'A', status: 'running', run_id: 'run-a' },
    { paper_id: 'B', status: 'pending', run_id: 'run-b' },
  ], { isPublished: () => true, artifactExists: (_paper, runId) => runId === 'run-b', reuseDraft: true, now: 0 });
  assert.deepEqual(report.already_published, []);
  assert.equal(next[0].status, 'pending');
  assert.deepEqual(report.reusable_artifacts, ['B:run-b']);
});

test('a queue without terminal state stays unchanged', () => {
  const { queue: next, report } = reconcileQueue([{ paper_id: 'A', status: 'already_published' }], { isPublished: () => true, now: 0 });
  assert.equal(next[0].status, 'already_published');
  assert.deepEqual(report.reset_pending, []);
  assert.deepEqual(report.already_published, []);
});

test('named jobs observe the shared writer lock and read their own state snapshot', async t => {
  const directory = await fixture(t);
  await cp(resolve('src'), join(directory, 'src'), {recursive:true});
  const queues = join(directory, 'data/distillation/batch');
  await acquireLock(queues, {jobId:'first', mode:'test', pid:process.pid});
  const job = join(queues, 'jobs/second');
  await mkdir(job, {recursive:true});
  await writeFile(join(job,'state.json'), JSON.stringify({status:'waiting_for_quota'}));
  const entry = join(directory, 'src/batch.mjs');
  const status = await run(entry, ['--status','--job','second']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /job first/);
  assert.match(status.stdout, /waiting_for_quota/);
  const recovery = await run(entry, ['--recover','--job','second']);
  assert.equal(recovery.code, 1);
  assert.match(recovery.stderr, /拒绝恢复/);
  await assert.rejects(stat(join(job,'queue.json')), /ENOENT/);
});
