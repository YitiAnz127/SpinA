/**
 * Queue reconciliation after a crash, timeout or manual stop.
 *
 * The database is the source of truth: a committed publication always wins over a stale
 * queue row, and an unfinished row returns to `pending` without losing its run_id so the
 * call cache can reuse completed stages.
 *
 * @typedef {{ paper_id: string, status: string, message?: string, revision?: number, run_id?: string,
 *   finished_at?: string, resume_at?: string, error_kind?: string }} QueueEntry
 */

/**
 * @param {QueueEntry[]} queue
 * @param {{ isPublished: (paperId: string) => boolean, artifactExists?: (paperId: string, runId: string) => boolean,
 *   reuseDraft?: boolean, now?: number }} options
 */
export function reconcileQueue(queue, options) {
  const { isPublished, artifactExists = () => false, reuseDraft = false, now = Date.now() } = options;
  /** @type {{ total: number, reset_pending: string[], already_published: string[], reusable_artifacts: string[], waiting_kept: string[] }} */
  const report = { total: queue.length, reset_pending: [], already_published: [], reusable_artifacts: [], waiting_kept: [] };
  const next = queue.map(item => ({ ...item }));
  for (const item of next) {
    const published = isPublished(item.paper_id);
    // A committed transaction wins over a stale queue row: never re-charge a published paper.
    if (published && !reuseDraft && item.status !== 'already_published') {
      item.status = 'already_published';
      item.message = '恢复：数据库中已有发布记录，跳过重复发布';
      item.finished_at = new Date(now).toISOString();
      delete item.error_kind;
      delete item.resume_at;
      report.already_published.push(item.paper_id);
      continue;
    }
    const active = item.status === 'running' || item.status === 'claimed';
    const waiting = typeof item.status === 'string' && item.status.startsWith('waiting_');
    const expiredWait = waiting && Boolean(item.resume_at) && Date.parse(String(item.resume_at)) <= now;
    if (active || expiredWait) {
      item.status = 'pending';
      delete item.resume_at;
      item.message = active ? '恢复：上次进程未留下终态，已重排为待处理' : '恢复：等待窗口已过，已重排为待处理';
      report.reset_pending.push(item.paper_id);
    } else if (waiting) report.waiting_kept.push(item.paper_id);
    // Artifacts written before a failed transaction stay usable through the call cache.
    if (item.run_id && (!published || reuseDraft) && artifactExists(item.paper_id, item.run_id)) {
      report.reusable_artifacts.push(`${item.paper_id}:${item.run_id}`);
    }
  }
  return { queue: next, report };
}

/**
 * Recompute the status counts written to state.json so the dashboard matches the queue.
 * @param {QueueEntry[]} queue
 */
export function statusCounts(queue) {
  return Object.fromEntries([...new Set(queue.map(item => item.status))].map(status => [status, queue.filter(item => item.status === status).length]));
}
