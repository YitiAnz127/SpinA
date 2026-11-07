import { mkdir, readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { saveJson } from './batch-io.mjs';
import { readCatalog } from './distillation/catalog.ts';
import { runDistillation } from './distillation/pipeline.ts';
import { resolvePaper } from './distillation/documents.ts';
import { imageContent } from './distillation/images.ts';
import { ExperimentStore } from './distillation/store.ts';
import { createDeepSeekCall, deepSeekConfig } from './distillation/deepseek.ts';
import { SOL_POLICY, SOL_LABEL } from './model-policy.ts';
import { quotaRetryDelay } from './batch-retry.mjs';
import { batchModelKey, batchRequestKey, compactCallCache, checkedExtraction, sameSourceVersions, validateBatchOutput } from './batch-cache.ts';
import { sourceVersion } from './distillation/source-version.ts';
import { classifyError } from './errors.ts';
import { acquireLock, describeLock, heartbeat, lockStatus, readLock, releaseLock, LOCK_FILE } from './batch-lock.mjs';
import { reconcileQueue, statusCounts } from './batch-recover.mjs';
import { table } from './cli-format.mjs';

/** @typedef {ReturnType<typeof checkedExtraction>} SavedExtraction */
/** @typedef {SavedExtraction['metadata'] & { usage?: unknown, seconds?: number }} CallMetadata */
/** @typedef {{ source_versions: import('./distillation/source-version.ts').SourceVersion[], requests: {
 * stage: string, output: string, metadata: CallMetadata, model_key?: string, request_key?: string, system?: string, input?: string
 * }[] }} CallCache */
/** @typedef {{ paper_id: string, status: import('./distillation/store.ts').RunState['status'] | 'pending' | 'claimed' | 'already_published' | 'source_unavailable' | 'waiting_for_quota' | 'waiting_for_network',
 * message?: string, revision?: number, run_id?: string, finished_at?: string, resume_at?: string, error_kind?: import('./errors.ts').ErrorKind }} QueueItem */
/** @typedef {{ status: string, mode: string, model: string, reasoning: string, distillation_model: string, distillation_reasoning: string,
 * concurrency: number, current_paper: string | null, current_stage: string | null, active_papers: Record<string, string>,
 * updated_at: string, resume_at: string | null, run_id?: string }} BatchControl */
/** @param {unknown} error */
const errorMessage = error => error instanceof Error ? error.message : String(error);
const root = fileURLToPath(new URL('../', import.meta.url));
/** @type {string | null} */
let lockInstanceId = null;
const checkOnly = process.argv.includes('--check-only');
const repairExisting = process.argv.includes('--repair-existing');
const distillOnly = process.argv.includes('--distill-only');
const jobAt = process.argv.indexOf('--job');
const jobId = jobAt >= 0 ? process.argv[jobAt + 1] : null;
if (jobAt >= 0 && !/^[a-z][a-z0-9-]{0,63}$/.test(jobId ?? '')) throw Error('--job 需要小写字母开头的任务名，仅含字母、数字和连字符');
if ([checkOnly, repairExisting, distillOnly].filter(Boolean).length > 1) throw Error('--distill-only、--check-only 与 --repair-existing 不能同时使用');
const reuseDraft = checkOnly || repairExisting;
const afterAt = process.argv.indexOf('--after');
const onlyAt = process.argv.indexOf('--only');
const statusOnly = process.argv.includes('--status');
const recoverOnly = process.argv.includes('--recover');
if (statusOnly && recoverOnly) throw Error('--status 与 --recover 不能同时使用');
if (afterAt >= 0 && !/^SPINA-\d{4}$/.test(process.argv[afterAt + 1] ?? '')) throw Error('用法：npm run batch -- --after SPINA-0005');
const after = afterAt >= 0 ? Number(process.argv[afterAt + 1].slice(-4)) : 0;
const onlyIds = onlyAt >= 0 ? (process.argv[onlyAt + 1] ?? '').split(',') : null;
if (onlyIds && (!onlyIds.length || onlyIds.some(id => !/^SPINA-\d{4}$/.test(id)) || new Set(onlyIds).size !== onlyIds.length)) throw Error('--only 需要逗号分隔的唯一 SPINA-#### ID');
const extractionDirectory = resolve(root, 'data/distillation/batch');
const directory = jobId ? resolve(extractionDirectory, 'jobs', jobId) : extractionDirectory;
await mkdir(directory, { recursive: true });
/** @param {string} name @param {unknown} value */
const save = (name, value) => saveJson(resolve(directory, name), value);
/** @template T @param {string} path @param {T} fallback @returns {Promise<T>} */
const load = async (path, fallback) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return fallback; throw error; } };
const statusOrder = ['pending', 'claimed', 'running', 'waiting_for_quota', 'waiting_for_network', 'published', 'published_uncertain', 'needs_review', 'already_published', 'source_unavailable', 'failed', 'skipped', 'cancelled'];

async function printStatus() {
  const queue = await load(resolve(directory, 'queue.json'), /** @type {QueueItem[]} */ ([]));
  const control = await load(resolve(directory, 'state.json'), /** @type {BatchControl | Record<string, never>} */ ({}));
  const lock = await readLock(extractionDirectory);
  const counts = new Map();
  for (const item of queue) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  console.log('SpinA 批处理状态');
  console.log(`队列目录：${relative(root, directory)}`);
  console.log(`单实例锁：${describeLock(lock, lockStatus(lock))}`);
  console.log(`控制状态：${'status' in control ? control.status : '无记录'}${'mode' in control && control.mode ? ` · ${control.mode}` : ''}${'updated_at' in control && control.updated_at ? ` · 更新于 ${control.updated_at}` : ''}`);
  console.log(`队列：${queue.length} 项`);
  if (queue.length) console.log(table(['状态', '数量'], statusOrder.filter(status => counts.has(status)).map(status => [status, counts.get(status)])));
  const attention = queue.filter(item => ['failed', 'waiting_for_quota', 'waiting_for_network', 'source_unavailable'].includes(item.status));
  if (attention.length) {
    console.log('\n需要处理的任务：');
    console.log(table(['论文', '状态', '错误类别', '说明'], attention.slice(0, 20).map(item => [item.paper_id, item.status, item.error_kind ?? '', item.message ?? ''])));
    if (attention.length > 20) console.log(`另有 ${attention.length - 20} 项，见 queue.json。`);
  }
  const repairable = queue.filter(item => item.status === 'pending' || item.status === 'failed').length;
  console.log(`\n可重试 ${repairable} 项。恢复入口：npm run batch -- --recover（对照数据库终态重排队列，不调用模型）。`);
}

async function recoverQueue() {
  const acquired = await acquireLock(extractionDirectory, { mode: 'recover', jobId });
  if (!acquired.acquired) {
    console.error(`拒绝恢复：${acquired.lock ? describeLock(acquired.lock, acquired.status) : '无法读取锁文件'}`);
    console.error('同一工作库只允许一个写入进程；请先等待其结束。');
    process.exitCode = 1; return;
  }
  const instanceId = acquired.lock.instance_id;
  try {
    const queue = await load(resolve(directory, 'queue.json'), /** @type {QueueItem[]} */ ([]));
    const store = await ExperimentStore.openExisting(root);
    /** @type {Map<string, number>} */
    const revisions = new Map();
    let reconciled, report;
    try {
      reconciled = reconcileQueue(queue, {
        isPublished: paperId => {
          const record = store?.getPaper(paperId);
          if (!record) return false;
          revisions.set(paperId, record.revision);
          return true;
        },
        artifactExists: (paperId, runId) => existsSync(resolve(root, 'data/distillation/runs', runId, 'record.json')),
        reuseDraft,
      });
      report = reconciled.report;
    } finally { store?.close(); }
    for (const item of reconciled.queue) {
      const revision = revisions.get(item.paper_id);
      if (revision !== undefined && item.status === 'already_published') item.revision = revision;
    }
    await save('queue.json', reconciled.queue);
    const state = await load(resolve(directory, 'state.json'), /** @type {Record<string, unknown> | null} */ (null));
    if (state && typeof state === 'object') {
      state.counts = statusCounts(reconciled.queue);
      state.updated_at = new Date().toISOString();
      await save('state.json', state);
    }
    console.log('批处理恢复完成（未调用模型）');
    console.log(`队列 ${report.total} 项；重排为待处理 ${report.reset_pending.length} 项；确认为已发布 ${report.already_published.length} 项；保留等待状态 ${report.waiting_kept.length} 项。`);
    if (report.reset_pending.length) console.log(`  重排：${report.reset_pending.slice(0, 12).join('、')}${report.reset_pending.length > 12 ? ' …' : ''}`);
    if (report.already_published.length) console.log(`  已发布：${report.already_published.slice(0, 12).join('、')}${report.already_published.length > 12 ? ' …' : ''}`);
    if (report.reusable_artifacts.length) console.log(`  可复用任务产物 ${report.reusable_artifacts.length} 个（调用缓存会跳过已完成阶段）：${report.reusable_artifacts.slice(0, 6).join('、')}`);
    console.log('下一步：用同一 --after/--only 命令继续；已发布论文不会重复扣费。');
  } finally { await releaseLock(extractionDirectory, instanceId); }
}

if (statusOnly) { await printStatus(); process.exit(0); }
if (recoverOnly) { await recoverQueue(); process.exit(process.exitCode ?? 0); }

if ((afterAt < 0) === (onlyAt < 0)) throw Error('请指定 --after SPINA-0005 或 --only SPINA-0006,SPINA-0007');
const distillConfig = deepSeekConfig();
const catalog = await readCatalog(root);
const acquired = await acquireLock(extractionDirectory, { mode: distillOnly ? 'distill_only' : checkOnly ? 'check_existing_drafts' : repairExisting ? 'repair_existing_drafts' : 'distill_and_verify', jobId });
if (!acquired.acquired) {
  console.error(`已有批处理进程在写同一个工作库，本次拒绝启动。\n${acquired.lock ? describeLock(acquired.lock, acquired.status) : '无法读取锁文件'}`);
  console.error('同一工作库只允许一个写入进程。用 npm run batch -- --status 查看进度，或等其结束后重试。');
  process.exit(1);
}
if (acquired.stale) console.warn(`已清理失效锁：${acquired.stale.lock.pid}（${acquired.stale.reason}）`);
lockInstanceId = acquired.lock.instance_id;
const ownInstanceId = lockInstanceId;
// Default signal termination stops all work; the next launch can reclaim a dead PID.
process.on('exit', () => {
  // Remove only our own lock; a lock replaced by another instance must survive.
  try {
    const lock = JSON.parse(readFileSync(resolve(extractionDirectory, LOCK_FILE), 'utf8'));
    if (lock.instance_id === ownInstanceId) rmSync(resolve(extractionDirectory, LOCK_FILE), { force: true });
  } catch { /* best effort on exit */ }
});
const queue = await load(resolve(directory, 'queue.json'), /** @type {QueueItem[]} */ ([]));
for (const item of queue) if (item.status === 'running' || item.status === 'claimed') item.status = 'pending';
const selectedPapers = onlyIds ? catalog.filter(p => onlyIds.includes(p.paper_id)) : catalog.filter(p => Number(p.paper_id.slice(-4)) > after);
if (onlyIds && selectedPapers.length !== onlyIds.length) throw Error('--only 中包含不在文献清单中的论文 ID');
for (const paper of selectedPapers) if (!queue.some(item => item.paper_id === paper.paper_id)) {
  /** @type {QueueItem} */
  const item={paper_id:paper.paper_id,status:'pending'};
  try { const prepared=await resolvePaper(root,{paper_id:paper.paper_id});await Promise.all(prepared.sources.map(s=>stat(resolve(root,s.path)))); }
  catch(error){item.status='source_unavailable';item.message=errorMessage(error);}
  queue.push(item);
}
const workItems = onlyIds ? queue.filter(item => onlyIds.includes(item.paper_id)) : queue;
if (onlyIds) for (const item of workItems) if (item.status !== 'already_published') item.status = 'pending';
await save('queue.json', queue);
const registry = new ModelRegistry(await ModelRuntime.create({ modelsStorePath: resolve(root, '.runtime/model-store.json') }));
const model = registry.find(SOL_POLICY.provider, SOL_POLICY.model);
const verifierLabel = SOL_LABEL;
if (!distillOnly && (!model || !registry.hasConfiguredAuth(model))) throw Error('请先在SpinA完成ChatGPT OAuth登录');
const concurrency = Number(process.env.SPINA_BATCH_CONCURRENCY ?? 2);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw Error('SPINA_BATCH_CONCURRENCY 必须是 1–4 的整数');
/** @type {BatchControl} */
const control = { status: 'running', mode: distillOnly ? 'distill_only' : checkOnly ? 'check_existing_drafts' : repairExisting ? 'repair_existing_drafts' : 'distill_and_verify', model: verifierLabel, reasoning: SOL_POLICY.reasoning, distillation_model: `deepseek/${distillConfig.model}`, distillation_reasoning: distillConfig.effort, concurrency, current_paper: null, current_stage: null, active_papers: {}, updated_at: '', resume_at: null };
/** @param {unknown} value */
const emit = value => console.log(JSON.stringify(value));
let snapshots=Promise.resolve();
const snapshot = () => { control.updated_at = new Date().toISOString();const state={...structuredClone(control),counts:Object.fromEntries([...new Set(queue.map(x=>x.status))].map(s=>[s,queue.filter(x=>x.status===s).length]))},items=structuredClone(queue);snapshots=snapshots.catch(()=>{}).then(async()=>{await save('state.json',state);await save('queue.json',items);
  // A replaced lock means another process now owns this database; stop instead of writing on.
  // A transient write failure is reported but retried on the next snapshot.
  if (lockInstanceId) {
    try {
      if (!await heartbeat(extractionDirectory, lockInstanceId)) { stopRequested = true; emit({ event: 'lock_lost', instance_id: lockInstanceId }); }
    } catch (error) { emit({ event: 'lock_heartbeat_failed', message: errorMessage(error) }); }
  }
});return snapshots; };
let stopRequested = false;
const stopFileRequested = async () => Boolean((await load(resolve(directory, 'control.json'), /** @type {{stop?: boolean}} */ ({}))).stop);
/** @param {QueueItem} item @param {number} milliseconds */
const waitForItem = async (item, milliseconds) => {
  const resumeAt = Date.now() + milliseconds;
  item.resume_at = new Date(resumeAt).toISOString();
  await snapshot();
  while (Date.now() < resumeAt) {
    await new Promise(done => setTimeout(done, Math.min(10000, resumeAt - Date.now())));
    if (await stopFileRequested()) { stopRequested = true; return false; }
  }
  delete item.resume_at;
  return true;
};
/** @param {number} milliseconds @param {string} status */
const waitBeforeWorkers = async (milliseconds, status) => {
  const resumeAt = Date.now() + milliseconds;
  control.status = status; control.resume_at = new Date(resumeAt).toISOString(); await snapshot();
  while (Date.now() < resumeAt) {
    await new Promise(done => setTimeout(done, Math.min(30000, resumeAt - Date.now())));
    if (await stopFileRequested()) { stopRequested = true; break; }
  }
  control.resume_at = null; control.status = stopRequested ? 'stopped' : 'running';
  await snapshot();
};

if(process.argv.includes('--require-five-current')){
  while(true){
    const store=await ExperimentStore.openExisting(root);
    const ready=Array.from({length:5},(_,i)=>store?.getPaper(`SPINA-${String(i+1).padStart(4,'0')}`)).every(record=>record?.verified_by.includes('live image verification'));
    store?.close();if(ready)break;
    await waitBeforeWorkers(30000,'waiting_for_first_five');
    if (stopRequested) break;
  }
}

/** @param {QueueItem} item */
const processItem = async item => {
  control.active_papers[item.paper_id] = 'preparing';
  control.current_paper = item.paper_id; control.current_stage = 'preparing'; item.status = 'running'; await snapshot();
  try {
    const existing = await ExperimentStore.openExisting(root); const record = existing?.getPaper(item.paper_id); existing?.close();
    if (record && !reuseDraft) { item.status = 'already_published'; item.revision = record.revision; await snapshot(); return; }
    let prepared;
    try {
      prepared = await resolvePaper(root, { paper_id: item.paper_id });
      await Promise.all(prepared.sources.map(s => stat(resolve(root, s.path))));
    } catch (error) {
      item.status = 'source_unavailable'; item.message = errorMessage(error); item.finished_at = new Date().toISOString();
      await snapshot(); emit({ event: 'paper_finished', ...item }); return;
    }
    const versions = await Promise.all(prepared.sources.map(source => sourceVersion(root, source.path)));
    const cachePath = resolve(directory, item.paper_id + '-calls.json');
    let existingCache = await load(cachePath, /** @type {CallCache | null} */ (null));
    if (!existingCache && jobId && reuseDraft) existingCache = await load(resolve(extractionDirectory, item.paper_id + '-calls.json'), /** @type {CallCache | null} */ (null));
    const savedExtraction = reuseDraft
      ? checkedExtraction(await load(resolve(extractionDirectory, item.paper_id + '-distill-last.json'), /** @type {SavedExtraction | null} */ (null)), existingCache, versions) : null;
    /** @type {CallCache} */
    let cache = existingCache && sameSourceVersions(existingCache.source_versions, versions) ? existingCache : { source_versions: versions, requests: [] };
    cache = compactCallCache(cache);
    let transientFailures = 0;
    while (true) {
      if (stopRequested || await stopFileRequested()) { stopRequested = true; item.status = 'pending'; return; }
      if (!sameSourceVersions(versions, await Promise.all(prepared.sources.map(source => sourceVersion(root, source.path))))) throw Error('等待期间来源已改变，请重新启动任务；不会将旧缓存绑定到新来源');
    /** @type {unknown} */
    let resourceError = null;
    /** @type {import('./distillation/agents.ts').ModelCall} */
    const call = async request => {
      if (distillOnly && request.stage !== 'distill') {
        if (request.stage === 'verify') {
          emit({ paper_id: item.paper_id, stage: 'verify', event: 'skip_verification', reason: 'distill_only_mode' });
          return JSON.stringify({ source_identity: 'ambiguous', coverage: 'undetermined', issues: [], samples: [], notes: ['未执行独立核验：本次仅完成第一遍蒸馏'] });
        }
        throw Error('只蒸馏模式不执行修正');
      }
      if (savedExtraction && request.stage === 'distill') {
        emit({ paper_id: item.paper_id, stage: 'distill', event: 'reuse_existing_deepseek_draft', model: savedExtraction.metadata.model, reasoning: savedExtraction.metadata.reasoning });
        return savedExtraction.output;
      }
      if (checkOnly && request.stage === 'repair') throw Error('只检查模式不执行修正');
      const modelKey = batchModelKey(request.stage, verifierLabel, distillConfig);
      const requestKey = batchRequestKey(request.system, request.input);
      const cached = cache.requests.find(c => c.model_key === modelKey && c.stage === request.stage && c.request_key === requestKey);
      if (cached) { validateBatchOutput(request, cached.output); emit({ paper_id: item.paper_id, stage: request.stage, event: 'reuse_verified_output' }); return cached.output; }
      const started = Date.now(); emit({ paper_id: item.paper_id, stage: request.stage, event: 'request_start', model_key: modelKey, images: request.images?.length ?? 0 });
      let output;
      /** @type {CallMetadata | undefined} */
      let metadata;
      try {
        if (request.stage !== 'verify') {
          output = await createDeepSeekCall(root, distillConfig, { onResult: value => { metadata = value; } })(request);
        } else {
          if (!model) throw Error('请先在SpinA完成ChatGPT OAuth登录');
          const text = request.system + request.input;
          const outputBudget = Math.min(SOL_POLICY.outputTokens, model.maxTokens);
          const estimate = Math.ceil([...text].reduce((sum, c) => sum + (c.charCodeAt(0) > 127 ? 1.5 : 1 / 3), 0)) + (request.images?.length ?? 0) * 2500 + outputBudget;
          if (estimate > model.contextWindow) throw Error('正文、SI、图像和草稿超出核验模型上下文容量；不截断来源');
          const result = await registry.streamSimple(model, { systemPrompt: request.system, messages: [{ role: 'user', content: request.images?.length ? [{ type: 'text', text: request.input }, ...await imageContent(root, request.images)] : request.input, timestamp: Date.now() }] }, { transport: 'sse', sessionId: `spina-${item.paper_id}`, reasoning: SOL_POLICY.reasoning, maxTokens: outputBudget, timeoutMs: 1200000, maxRetries: 1, onPayload: payload => {
            if (!payload || typeof payload !== 'object' || !('model' in payload) || payload.model !== SOL_POLICY.model ||
              !('reasoning' in payload) || !payload.reasoning || typeof payload.reasoning !== 'object' ||
              !('effort' in payload.reasoning) || payload.reasoning.effort !== SOL_POLICY.reasoning) throw Error('核验模型或推理强度不符合设置');
          } }).result();
          if (result.stopReason !== 'stop') throw Error(result.errorMessage ?? result.stopReason);
          output = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          metadata = { model: result.model, provider: result.provider, reasoning: SOL_POLICY.reasoning, usage: result.usage, stop_reason: result.stopReason };
        }
      }
      catch (error) { resourceError = error; throw error; }
      if (!metadata) throw Error('模型未返回调用元数据，无法保存缓存');
      metadata = { ...metadata, seconds: (Date.now() - started) / 1000 };
      await save(`${item.paper_id}-${request.stage}-last.json`, { source_versions: versions, metadata, output }); emit({ paper_id: item.paper_id, stage: request.stage, event: 'request_end', ...metadata });
      validateBatchOutput(request, output);
      cache.requests.push({ model_key: modelKey, stage: request.stage, request_key: requestKey, output, metadata }); cache = compactCallCache(cache); await save(item.paper_id+'-calls.json',cache);
      return output;
    };
    const run = await runDistillation(root, { paper_id: item.paper_id }, call, { maxRepairs: (checkOnly || distillOnly) ? 0 : 3, focusedRepairs: true, modelLabel: verifierLabel, distillationModelLabel: savedExtraction ? `deepseek/${savedExtraction.metadata.model}:${savedExtraction.metadata.reasoning}` : `deepseek/${distillConfig.model}:${distillConfig.effort}`, onProgress: run => { control.active_papers[item.paper_id] = run.stage; control.current_paper = item.paper_id; control.current_stage = run.stage; control.run_id = run.run_id; void snapshot().catch(error => { stopRequested = true; emit({ event: 'snapshot_failed', message: errorMessage(error) }); }); } });
    if (savedExtraction) {
      const provenanceStore = await ExperimentStore.open(root);
      try { await provenanceStore.saveArtifact(run, 'check-input.json', { mode: checkOnly ? 'check_existing_draft' : 'repair_existing_draft', original_output: `data/distillation/batch/${item.paper_id}-distill-last.json`, model: savedExtraction.metadata.model, reasoning: savedExtraction.metadata.reasoning, source_versions: versions, new_distillation_calls: 0 }); }
      finally { provenanceStore.close(); }
    }
    item.run_id = run.run_id; item.message = run.message;
    const errorKind = run.error_kind ?? classifyError(resourceError ?? run.message);
    if (run.status === 'failed' || run.status === 'cancelled') item.error_kind = errorKind;
    else delete item.error_kind;
    if (run.status === 'failed' && errorKind === 'quota') {
      item.status = 'waiting_for_quota'; item.message = run.message; emit({ event: 'quota_wait', paper_id: item.paper_id, message: run.message });
      // No paid fallback or reset-credit use. Keep successful earlier stages and retry after the quota window.
      if (!await waitForItem(item, quotaRetryDelay(run.message))) return;
      item.status = 'running'; continue;
    }
    if (run.status === 'failed' && (errorKind === 'network' || errorKind === 'timeout')) {
      // 真正的传输层故障才重试，且最多 2 次：模型输出不合规（JSON 错位、结构不符）必须立即失败，不能反复烧额度。
      transientFailures++;
      if (transientFailures > 2) { item.status = 'failed'; item.message = `${run.message}（网络重试 ${transientFailures - 1} 次后放弃）`; item.finished_at = new Date().toISOString(); await snapshot(); emit({ event: 'paper_finished', ...item }); break; }
      item.status = 'waiting_for_network'; item.message = run.message;
      if (!await waitForItem(item, Math.min(15, transientFailures) * 60000)) return;
      item.status = 'running'; continue;
    }
    item.status = run.status === 'failed' && errorKind === 'source' ? 'source_unavailable' : run.status;
    item.finished_at = new Date().toISOString(); await snapshot(); emit({ event: 'paper_finished', ...item }); break;
    }
  } catch (error) {
    item.status = 'failed'; item.message = errorMessage(error); item.error_kind = classifyError(error); item.finished_at = new Date().toISOString();
    await snapshot(); emit({ event: 'paper_finished', ...item });
  } finally {
    delete control.active_papers[item.paper_id];
    control.current_paper = Object.keys(control.active_papers)[0] ?? null;
    control.current_stage = control.current_paper ? control.active_papers[control.current_paper] : null;
    await snapshot();
  }
};

const worker = async () => {
  while (!stopRequested) {
    if (await stopFileRequested()) { stopRequested = true; break; }
    const item = workItems.find(candidate => candidate.status === 'pending');
    if (!item) break;
    item.status = 'claimed';
    await processItem(item);
  }
};

await Promise.all(Array.from({ length: concurrency }, () => worker()));
control.status = stopRequested || await stopFileRequested() ? 'stopped' : 'complete';
control.current_paper = Object.keys(control.active_papers)[0] ?? null;
control.current_stage = control.current_paper ? control.active_papers[control.current_paper] : null;
await snapshot();
