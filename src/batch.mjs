import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { ReadOnlyAuthStorage } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js';
import { runDistillation } from './distillation/pipeline.ts';
import { resolvePaper } from './distillation/documents.ts';
import { imageContent } from './distillation/images.ts';
import { ExperimentStore } from './distillation/store.ts';
import { applyFocusedRepair, parseDraft, parseVerification } from './distillation/schema.ts';
import { createDeepSeekCall, deepSeekConfig } from './distillation/deepseek.ts';
import { SOL_POLICY, SOL_LABEL } from './model-policy.ts';
import { quotaRetryDelay } from './batch-retry.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
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
if ((afterAt < 0) === (onlyAt < 0)) throw Error('请指定 --after SPINA-0005 或 --only SPINA-0006,SPINA-0007');
if (afterAt >= 0 && !/^SPINA-\d{4}$/.test(process.argv[afterAt + 1] ?? '')) throw Error('用法：npm run batch -- --after SPINA-0005');
const after = afterAt >= 0 ? Number(process.argv[afterAt + 1].slice(-4)) : null;
const onlyIds = onlyAt >= 0 ? (process.argv[onlyAt + 1] ?? '').split(',') : null;
if (onlyIds && (!onlyIds.length || onlyIds.some(id => !/^SPINA-\d{4}$/.test(id)) || new Set(onlyIds).size !== onlyIds.length)) throw Error('--only 需要逗号分隔的唯一 SPINA-#### ID');
const distillConfig = deepSeekConfig();
const extractionDirectory = resolve(root, 'data/distillation/batch');
const directory = jobId ? resolve(extractionDirectory, 'jobs', jobId) : extractionDirectory;
await mkdir(directory, { recursive: true });
const save = async (name, value) => { const path=resolve(directory,name);await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n');await rename(path+'.tmp',path); };
const load = async (path, fallback) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
const catalog = (await readFile(resolve(root, 'data/literature/selected-500.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const queue = await load(resolve(directory, 'queue.json'), []);
for (const item of queue) if (item.status === 'running' || item.status === 'claimed') item.status = 'pending';
const selectedPapers = onlyIds ? catalog.filter(p => onlyIds.includes(p.paper_id)) : catalog.filter(p => Number(p.paper_id.slice(-4)) > after);
if (onlyIds && selectedPapers.length !== onlyIds.length) throw Error('--only 中包含不在文献清单中的论文 ID');
for (const paper of selectedPapers) if (!queue.some(item => item.paper_id === paper.paper_id)) {
  const item={paper_id:paper.paper_id,status:'pending'};
  try { const prepared=await resolvePaper(root,{paper_id:paper.paper_id});await Promise.all(prepared.sources.map(s=>stat(resolve(root,s.path)))); }
  catch(error){item.status='source_unavailable';item.message=error.message;}
  queue.push(item);
}
const workItems = onlyIds ? queue.filter(item => onlyIds.includes(item.paper_id)) : queue;
if (onlyIds) for (const item of workItems) if (item.status !== 'already_published') item.status = 'pending';
await save('queue.json', queue);
const registry = new ModelRegistry(await ModelRuntime.create({ credentials: new ReadOnlyAuthStorage(), modelsStorePath: resolve(root, '.runtime/model-store.json') }));
const model = registry.find(SOL_POLICY.provider, SOL_POLICY.model);
if (!distillOnly && (!model || !registry.hasConfiguredAuth(model))) throw Error('请先在SpinA完成ChatGPT OAuth登录');
const concurrency = Number(process.env.SPINA_BATCH_CONCURRENCY ?? 2);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw Error('SPINA_BATCH_CONCURRENCY 必须是 1–4 的整数');
const control = { status: 'running', mode: distillOnly ? 'distill_only' : checkOnly ? 'check_existing_drafts' : repairExisting ? 'repair_existing_drafts' : 'distill_and_verify', model: `${SOL_POLICY.provider}/${SOL_POLICY.model}`, reasoning: SOL_POLICY.reasoning, distillation_model: `deepseek/${distillConfig.model}`, distillation_reasoning: distillConfig.effort, concurrency, current_paper: null, current_stage: null, active_papers: {}, updated_at: '', resume_at: null };
const emit = value => console.log(JSON.stringify(value));
let snapshots=Promise.resolve();
const snapshot = () => { control.updated_at = new Date().toISOString();const state={...structuredClone(control),counts:Object.fromEntries([...new Set(queue.map(x=>x.status))].map(s=>[s,queue.filter(x=>x.status===s).length]))},items=structuredClone(queue);snapshots=snapshots.then(async()=>{await save('state.json',state);await save('queue.json',items);});return snapshots; };
let stopRequested = false;
const stopFileRequested = async () => Boolean((await load(resolve(directory, 'control.json'), {})).stop);
const waitForItem = async (item, milliseconds) => {
  item.resume_at = new Date(Date.now() + milliseconds).toISOString();
  await snapshot();
  while (Date.now() < Date.parse(item.resume_at)) {
    await new Promise(done => setTimeout(done, Math.min(10000, Date.parse(item.resume_at) - Date.now())));
    if (await stopFileRequested()) { stopRequested = true; return false; }
  }
  delete item.resume_at;
  return true;
};
const waitBeforeWorkers = async (milliseconds, status) => {
  control.status = status; control.resume_at = new Date(Date.now() + milliseconds).toISOString(); await snapshot();
  while (Date.now() < Date.parse(control.resume_at)) {
    await new Promise(done => setTimeout(done, Math.min(30000, Date.parse(control.resume_at) - Date.now())));
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
      item.status = 'source_unavailable'; item.message = error.message; item.finished_at = new Date().toISOString();
      await snapshot(); emit({ event: 'paper_finished', ...item }); return;
    }
    const versions = await Promise.all(prepared.sources.map(async source => { const info = await stat(resolve(root, source.path)); return { path: source.path, size: info.size, mtime_ms: info.mtimeMs }; }));
    const cachePath = resolve(directory, item.paper_id + '-calls.json');
    let cache = await load(cachePath, null);
    if (!cache && jobId && reuseDraft) cache = await load(resolve(extractionDirectory, item.paper_id + '-calls.json'), null);
    cache ??= { source_versions: versions, requests: [] };
    let savedExtraction;
    if (reuseDraft) {
      savedExtraction = await load(resolve(extractionDirectory, item.paper_id + '-distill-last.json'), null);
      if (!savedExtraction || savedExtraction.metadata?.provider !== 'deepseek' || savedExtraction.metadata?.stop_reason !== 'stop' || typeof savedExtraction.output !== 'string') throw Error('没有可检查的完整 DeepSeek 草稿');
      if (JSON.stringify(cache.source_versions) !== JSON.stringify(versions)) throw Error('来源已改变，不能复用旧草稿检查');
    }
    if (JSON.stringify(cache.source_versions) !== JSON.stringify(versions)) cache = { source_versions: versions, requests: [] };
    let transientFailures = 0;
    while (true) {
      if (stopRequested || await stopFileRequested()) { stopRequested = true; item.status = 'pending'; return; }
    let resourceError = null;
    const call = async request => {
      if (distillOnly && request.stage !== 'distill') {
        if (request.stage === 'verify') {
          emit({ paper_id: item.paper_id, stage: 'verify', event: 'skip_verification', reason: 'distill_only_mode' });
          return JSON.stringify({ source_identity: 'ambiguous', coverage: 'undetermined', issues: [], samples: [], notes: ['未执行独立核验：本次仅完成第一遍蒸馏'] });
        }
        throw Error('只蒸馏模式不执行修正');
      }
      if (reuseDraft && request.stage === 'distill') {
        emit({ paper_id: item.paper_id, stage: 'distill', event: 'reuse_existing_deepseek_draft', model: savedExtraction.metadata.model, reasoning: savedExtraction.metadata.reasoning });
        return savedExtraction.output;
      }
      if (checkOnly && request.stage === 'repair') throw Error('只检查模式不执行修正');
      const modelKey = request.stage === 'verify' ? SOL_LABEL : `deepseek/${distillConfig.model}:${distillConfig.effort}`;
      const cached = cache.requests.find(c => c.model_key === modelKey && c.stage === request.stage && c.system === request.system && c.input === request.input);
      if (cached) { emit({ paper_id: item.paper_id, stage: request.stage, event: 'reuse_verified_output' }); return cached.output; }
      const started = Date.now(); emit({ paper_id: item.paper_id, stage: request.stage, event: 'request_start', model_key: modelKey, images: request.images?.length ?? 0 });
      let output, metadata;
      try {
        if (request.stage !== 'verify') {
          output = await createDeepSeekCall(root, distillConfig, { onResult: value => { metadata = value; } })(request);
        } else {
          const text = request.system + request.input;
          const outputBudget = Math.min(SOL_POLICY.outputTokens, model.maxTokens);
          const estimate = Math.ceil([...text].reduce((sum, c) => sum + (c.charCodeAt(0) > 127 ? 1.5 : 1 / 3), 0)) + (request.images?.length ?? 0) * 2500 + outputBudget;
          if (estimate > model.contextWindow) throw Error('正文、SI、图像和草稿超出核验模型上下文容量；不截断来源');
          const result = await registry.streamSimple(model, { systemPrompt: request.system, messages: [{ role: 'user', content: request.images?.length ? [{ type: 'text', text: request.input }, ...await imageContent(root, request.images)] : request.input, timestamp: Date.now() }] }, { transport: 'sse', reasoning: SOL_POLICY.reasoning, maxTokens: outputBudget, timeoutMs: 1200000, maxRetries: 1, onPayload: payload => { if (payload.model !== SOL_POLICY.model || payload.reasoning?.effort !== SOL_POLICY.reasoning) throw Error('核验模型或推理强度不符合设置'); } }).result();
          if (result.stopReason !== 'stop') throw Error(result.errorMessage ?? result.stopReason);
          output = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          metadata = { model: result.model, provider: result.provider, reasoning: SOL_POLICY.reasoning, usage: result.usage, stop_reason: result.stopReason };
        }
      }
      catch (error) { resourceError = error.message; throw error; }
      metadata = { ...metadata, seconds: (Date.now() - started) / 1000 };
      await save(`${item.paper_id}-${request.stage}-last.json`, { metadata, output }); emit({ paper_id: item.paper_id, stage: request.stage, event: 'request_end', ...metadata });
      if (request.stage === 'verify') parseVerification(output);
      else if (request.outputShape === 'patch') applyFocusedRepair(output, JSON.parse(request.input).draft);
      else parseDraft(output);
      cache.requests.push({ model_key: modelKey, stage: request.stage, system: request.system, input: request.input, output, metadata }); await save(item.paper_id+'-calls.json',cache);
      return output;
    };
    const run = await runDistillation(root, { paper_id: item.paper_id }, call, { maxRepairs: (checkOnly || distillOnly) ? 0 : 3, focusedRepairs: false, modelLabel: SOL_LABEL, distillationModelLabel: `deepseek/${distillConfig.model}:${distillConfig.effort}`, onProgress: run => { control.active_papers[item.paper_id] = run.stage; control.current_paper = item.paper_id; control.current_stage = run.stage; control.run_id = run.run_id; void snapshot(); } });
    if (reuseDraft) {
      const provenanceStore = await ExperimentStore.open(root);
      try { await provenanceStore.saveArtifact(run, 'check-input.json', { mode: checkOnly ? 'check_existing_draft' : 'repair_existing_draft', original_output: `data/distillation/batch/${item.paper_id}-distill-last.json`, model: savedExtraction.metadata.model, reasoning: savedExtraction.metadata.reasoning, source_versions: versions, new_distillation_calls: 0 }); }
      finally { provenanceStore.close(); }
    }
    item.run_id = run.run_id; item.message = run.message;
    if (run.status === 'failed' && /usage.limit|quota|rate.limit|rate_limit|429|too many|limit.*reached/i.test(resourceError ?? run.message)) {
      item.status = 'waiting_for_quota'; item.message = run.message; emit({ event: 'quota_wait', paper_id: item.paper_id, message: run.message });
      // No paid fallback or reset-credit use. Keep successful earlier stages and retry after the quota window.
      if (!await waitForItem(item, quotaRetryDelay(run.message))) return;
      item.status = 'running'; continue;
    }
    if (run.status === 'failed' && /fetch failed|network|socket|terminated|ECONN|timeout|\b52[0-9]\b|gateway timeout|upstream timeout/i.test(resourceError ?? run.message)) { item.status = 'waiting_for_network'; item.message = run.message; transientFailures++; if (!await waitForItem(item, Math.min(15,transientFailures)*60000)) return; item.status='running';continue; }
    if(run.status==='failed'&&/只有 SI|尚缺正文|没有可读文本层|不是 PDF/.test(run.message))run.status='source_unavailable';
    item.status = run.status; item.finished_at = new Date().toISOString(); await snapshot(); emit({ event: 'paper_finished', ...item }); break;
    }
  } catch (error) {
    item.status = 'failed'; item.message = error.message; item.finished_at = new Date().toISOString();
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
