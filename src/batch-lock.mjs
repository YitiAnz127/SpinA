import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

/**
 * Project-level single-writer lock for batch runs.
 *
 * The lock is keyed to the database directory, not the job directory: two jobs writing
 * the same `spina.sqlite` are the actual conflict, no matter where their queue files live.
 */
export const LOCK_FILE = '.batch.lock';
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * @typedef {object} LockRecord
 * @property {string} instance_id
 * @property {number} pid
 * @property {string} hostname
 * @property {string} started_at
 * @property {string} heartbeat_at
 * @property {string} [mode]
 * @property {string | null} [job_id]
 * @property {string} [archived_at]
 *
 * @typedef {{ state: 'free' } | { state: 'held' | 'stale', reason: string, age_ms?: number }} LockState
 */

/** @param {string} directory */
export const lockPath = directory => resolve(directory, LOCK_FILE);

/** @param {unknown} pid */
export function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return /** @type {{ code?: string }} */ (error)?.code === 'EPERM'; }
}

/** @param {string} directory @returns {Promise<LockRecord | null>} */
export async function readLock(directory) {
  try { return JSON.parse((await readFile(lockPath(directory), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return null; throw error; }
}

/**
 * `held` means the owner may still be running; `stale` means the evidence says it is gone.
 * A different host can only be judged by heartbeat age, so it is never assumed dead early.
 * @param {LockRecord | null} lock
 * @param {{ now?: number, host?: string, ttlMs?: number, alive?: (pid: unknown) => boolean }} [options]
 * @returns {LockState}
 */
export function lockStatus(lock, options = {}) {
  if (!lock) return { state: 'free' };
  const { now = Date.now(), host = hostname(), ttlMs = DEFAULT_TTL_MS, alive = isProcessAlive } = options;
  const heartbeat = Date.parse(lock.heartbeat_at ?? lock.started_at ?? '');
  const age = Number.isFinite(heartbeat) ? now - heartbeat : Number.POSITIVE_INFINITY;
  if (lock.hostname === host) {
    if (!alive(lock.pid)) return { state: 'stale', reason: `进程 ${lock.pid} 已退出`, age_ms: age };
    return { state: 'held', reason: `进程 ${lock.pid} 仍在运行`, age_ms: age };
  }
  if (age > ttlMs) return { state: 'stale', reason: `主机 ${lock.hostname} 的心跳已过期（${Math.round(age / 60000)} 分钟）`, age_ms: age };
  return { state: 'held', reason: `主机 ${lock.hostname} 的进程 ${lock.pid} 仍持有锁`, age_ms: age };
}

/**
 * @param {LockRecord | null} lock
 * @param {LockState} status
 */
export function describeLock(lock, status) {
  if (!lock) return '无锁';
  const since = lock.started_at ?? '未知时间';
  return `${status.state === 'stale' ? '失效锁' : '已被占用'}：pid ${lock.pid} · ${lock.hostname} · ${lock.mode ?? '未记录模式'}${lock.job_id ? ` · job ${lock.job_id}` : ''} · 开始于 ${since}${'reason' in status && status.reason ? `（${status.reason}）` : ''}`;
}

/** @param {string} directory @param {LockRecord} lock */
async function archiveStale(directory, lock) {
  const path = lockPath(directory);
  const archive = `${path}.stale`;
  await rm(archive, { force: true });
  await writeFile(archive, `${JSON.stringify({ ...lock, archived_at: new Date().toISOString() }, null, 2)}\n`);
  await rm(path, { force: true });
}

/**
 * Acquire the batch lock. Returns `{acquired:false}` with the current holder instead of
 * overwriting it. A lock is only broken when its owner is provably gone.
 * @param {string} directory
 * @param {{ instanceId?: string, pid?: number, host?: string, mode?: string, jobId?: string | null,
 *   now?: Date, ttlMs?: number, alive?: (pid: unknown) => boolean }} [options]
 * @returns {Promise<
 *   { acquired: true, lock: LockRecord, stale: { lock: LockRecord, reason: string } | null } |
 *   { acquired: false, lock: LockRecord | null, status: LockState, stale: { lock: LockRecord, reason: string } | null }
 * >}
 */
export async function acquireLock(directory, options = {}) {
  const {
    instanceId = randomUUID(), pid = process.pid, host = hostname(), mode = '', jobId = null,
    now = new Date(), ttlMs = DEFAULT_TTL_MS, alive = isProcessAlive,
  } = options;
  await mkdir(directory, { recursive: true });
  /** @type {LockRecord} */
  const lock = {
    instance_id: instanceId, pid, hostname: host,
    started_at: now.toISOString(), heartbeat_at: now.toISOString(), mode, job_id: jobId,
  };
  /** @type {{ lock: LockRecord, reason: string } | null} */
  let stale = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath(directory), `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
      return { acquired: true, lock, stale };
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error)?.code !== 'EEXIST') throw error;
      const existing = await readLock(directory);
      if (!existing) continue; // Holder released between EEXIST and read; retry once.
      const status = lockStatus(existing, { now: now.getTime(), host, ttlMs, alive });
      if (status.state !== 'stale' || attempt === 1) return { acquired: false, lock: existing, status, stale };
      // Serialize competing stale-lock recoveries. SQLite releases the guard on process exit.
      const guard = new DatabaseSync(resolve(directory, '.batch-recovery.sqlite'));
      try {
        try { guard.exec('BEGIN IMMEDIATE'); }
        catch (error) {
          if (/** @type {{errcode?: number}} */ (error).errcode !== 5) throw error;
          return { acquired: false, lock: existing, status: { state: 'held', reason: '其他进程正在接管失效锁' }, stale };
        }
        const current = await readLock(directory);
        if (current?.instance_id === existing.instance_id && lockStatus(current, { now: now.getTime(), host, ttlMs, alive }).state === 'stale') {
          stale = { lock: current, reason: status.reason };
          await archiveStale(directory, current);
        }
      } finally { guard.close(); }
    }
  }
  return { acquired: false, lock: await readLock(directory), status: { state: 'held', reason: '无法取得锁' }, stale };
}

/**
 * Refresh the heartbeat. Returns false when the lock now belongs to another instance.
 * @param {string} directory @param {string} instanceId @param {Date} [now]
 */
export async function heartbeat(directory, instanceId, now = new Date()) {
  const lock = await readLock(directory);
  if (!lock || lock.instance_id !== instanceId) return false;
  const next = { ...lock, heartbeat_at: now.toISOString() };
  const temporary = `${lockPath(directory)}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, lockPath(directory));
  return true;
}

/**
 * Release only our own lock; a replaced lock is left alone.
 * @param {string} directory @param {string} instanceId
 */
export async function releaseLock(directory, instanceId) {
  const lock = await readLock(directory).catch(() => null);
  if (!lock || lock.instance_id !== instanceId) return false;
  await rm(lockPath(directory), { force: true });
  return true;
}
