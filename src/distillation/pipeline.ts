import { DistillationAgent, VerificationAgent, type ModelCall } from './agents.ts';
import { readSources, resolvePaper, type DistillInput } from './documents.ts';
import { ExperimentStore, sourceManifest, deliveryRecord, type PublishedRecord, type RunState } from './store.ts';
import { derivePhaseMetalElements, draftReviewNotes, validateDraft, validateEvidence } from './schema.ts';
import type { Draft, DraftReviewNote, SourceDocument, Verification } from './schema.ts';
import { isSourceLimitationIssue } from './missing-information.ts';
import { classifyError, type ErrorKind } from '../errors.ts';

export interface PipelineOptions {
  signal?: AbortSignal;
  maxRepairs?: number;
  initialRepairAttempts?: number;
  reviewFeedback?: string;
  seedUncertain?: boolean;
  focusedRepairs?: boolean;
  requireFeedbackRepair?: boolean;
  modelLabel?: string;
  distillationModelLabel?: string;
  readSources?: typeof readSources;
  onProgress?: (run: RunState) => void;
}

function verificationStructureChecks(review: Verification, draft: Draft, sources: SourceDocument[]): string[] {
  const errors: string[] = [];
  const ids = draft.samples.map(sample => sample.local_id);
  const checked = review.samples.map(sample => sample.sample_local_id);
  if (checked.length !== ids.length || new Set(checked).size !== checked.length || ids.some(id => !checked.includes(id))) errors.push('核验报告未逐一覆盖当前样品，或引用了旧样品 ID');
  for (const issue of review.issues) {
    if (issue.sample_local_id !== null && !ids.includes(issue.sample_local_id)) errors.push('核验问题引用了未知样品 ID');
    errors.push(...validateEvidence(issue.source_evidence, sources, false));
    if (issue.resolution_status === 'confirmed_error' && issue.action === 'source_limit') errors.push('核验报告不能把已确认抽取错误标为来源限制');
  }
  for (const sample of review.samples) {
    const confirmed = review.issues.filter(issue => issue.resolution_status === 'confirmed_error');
    if (sample.has_confirmed_errors && !confirmed.some(issue => issue.sample_local_id === null || issue.sample_local_id === sample.sample_local_id)) errors.push(`核验样品 ${sample.sample_local_id} 的错误标志缺少本轮问题依据`);
    if (!sample.has_confirmed_errors && confirmed.some(issue => issue.sample_local_id === sample.sample_local_id)) errors.push(`核验样品 ${sample.sample_local_id} 的错误标志与本轮问题矛盾`);
  }
  return errors;
}

function verificationChecks(review: Verification, draft: Draft, sources: SourceDocument[]): string[] {
  const errors = verificationStructureChecks(review, draft, sources);
  // coverage 不再作为入库门槛：原文缺 SI、省略方法段不是抽取方能修复的问题，
  // 只作为核验报告的参考信息保留；具体缺失已由 source_limit issue 如实记录。
  if (review.source_identity !== 'confirmed') errors.push('核验未确认来源身份');
  if (review.issues.some(issue => issue.resolution_status === 'confirmed_error') || review.samples.some(sample => sample.has_confirmed_errors)) errors.push('当前记录仍有已确认错误');
  return errors;
}

function localReference<T extends { local_id: string }>(entries: T[], key: string | undefined): T | undefined {
  return entries.find(entry => entry.local_id === key) ?? (key && /^\d+$/.test(key) ? entries[Number(key)] : undefined);
}

/** Resolve known sample/phase IDs or array indices; unresolved paths retain the broader issue scope. */
function issueTargetsPhase(issue: Verification['issues'][number], draft: Draft, sample: Draft['samples'][number], phaseId: string): boolean {
  if (issue.sample_local_id !== null && issue.sample_local_id !== sample.local_id) return false;
  const fields = issue.field_path.replace(/\[["']?([^"'\[\]]+)["']?\]/g, '.$1').split('.');
  const sampleAt = fields.indexOf('samples'), phaseAt = fields.indexOf('phases');
  if (issue.sample_local_id === null && sampleAt >= 0) {
    const target = localReference(draft.samples, fields[sampleAt + 1]);
    if (target && target.local_id !== sample.local_id) return false;
  }
  const target = phaseAt >= 0 ? localReference(sample.phases, fields[phaseAt + 1]) : undefined;
  return !target || target.local_id === phaseId;
}

export function matchingEntries(draft: Draft, review: Verification, possible = false): PublishedRecord['match_entries'] {
  if (review.source_identity !== 'confirmed' || !['original_experiments', 'insufficient_sources'].includes(draft.assessment)) return [];
  return draft.samples.flatMap(sample => {
    const verdict = review.samples.find(verdict => verdict.sample_local_id === sample.local_id);
    if ((!possible && !verdict?.can_match) || sample.material_state === 'intermediate' || sample.material_state === 'unspecified') return [];
    return sample.phases.flatMap(phase => {
      const blocked = review.issues.some(issue => issue.affects_matching && issue.resolution_status !== 'resolved' &&
        (!possible || issue.resolution_status === 'confirmed_error') && issueTargetsPhase(issue, draft, sample, phase.local_id));
      if (blocked) return [];
      const identity = String(phase.identity.value).toLowerCase().trim();
      const spinelIdentity = ['spinel', 'normal_spinel', 'inverse_spinel', 'oxyspinel', 'spinel-type structure', 'spinel type structure'].includes(identity);
      if (phase.role !== 'target_spinel' || (!possible && (phase.identity.status !== 'reported' || !spinelIdentity))) return [];
      const candidate = possible ? structuredClone(phase) : phase;
      if (possible) {
        if (candidate.formula.raw && candidate.formula.value !== null && candidate.formula.evidence.length) candidate.formula.status = 'reported';
        if (candidate.metal_elements?.raw && Array.isArray(candidate.metal_elements.value) && candidate.metal_elements.evidence.length) candidate.metal_elements.status = 'reported';
      }
      const metals = derivePhaseMetalElements(candidate, true);
      return metals ? [{ sample_local_id: sample.local_id, phase_local_id: phase.local_id, metal_elements: metals, element_key: metals.join('|'), material_state: sample.material_state }] : [];
    });
  });
}

interface CheckedCandidate {
  draft: Draft; review: Verification; errors: string[]; notes: DraftReviewNote[]; round: number; score: number;
}

// 疑惑只标记"需要再检查"的实质问题：已确认错误，或该修而没修完的问题。
// 原文未报告、含糊或自身冲突（source_limit）直接在回答中保留，不算抽取疑惑。
const doubts = (review: Verification) =>
  review.issues.some(issue => issue.resolution_status === 'confirmed_error' ||
    (issue.resolution_status === 'unresolved' && !isSourceLimitationIssue(issue))) ||
  review.samples.some(sample => sample.has_confirmed_errors);
const repairableIssue = (issue: Verification['issues'][number]) => issue.resolution_status !== 'resolved' && (issue.resolution_status === 'confirmed_error' || issue.action !== 'source_limit');
const needsRepair = (review: Verification) => review.issues.some(repairableIssue) || review.samples.some(sample => sample.has_confirmed_errors ||
  (sample.has_unresolved_issues && !review.issues.some(issue => issue.resolution_status !== 'resolved' && issue.action === 'source_limit' && (issue.sample_local_id === null || issue.sample_local_id === sample.sample_local_id))));
const candidateScore = (review: Verification, notes: DraftReviewNote[]) =>
  review.issues.filter(issue => issue.resolution_status === 'confirmed_error').length * 10 +
  review.samples.filter(sample => sample.has_confirmed_errors).length + review.issues.filter(issue => issue.resolution_status === 'unresolved' && repairableIssue(issue)).length +
  notes.filter(note => note.kind === 'derived').length * 10;

export async function runDistillation(root: string, input: DistillInput, modelCall: ModelCall, options: PipelineOptions = {}): Promise<RunState> {
  const maxRepairs = options.maxRepairs ?? 3;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3) throw new Error('修正轮数必须为 0–3');
  const initialRepairAttempts = options.initialRepairAttempts ?? 0;
  if (!Number.isInteger(initialRepairAttempts) || initialRepairAttempts < 0 || initialRepairAttempts > maxRepairs) throw new Error('已执行修正轮数必须在 0 与修正上限之间');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.paper_id)) throw new Error('无效的 paper_id');
  const store = await ExperimentStore.open(root);
  const run = store.createRun(input.paper_id);
  const progress = (stage: string) => {
    options.signal?.throwIfAborted();
    run.stage = stage;
    store.saveRun(run);
    options.onProgress?.({ ...run });
  };
  const finish = (status: RunState['status'], message: string, errorKind?: ErrorKind) => {
    run.status = status;
    run.message = message;
    if (errorKind) run.error_kind = errorKind;
    else delete run.error_kind;
    store.saveRun(run);
    return { ...run };
  };
  let lastResponse: { stage: string; response: string } | undefined;
  let repairAttempts = initialRepairAttempts;
  let publicationStarted = false;
  let fallback: ((reason?: string) => Promise<RunState>) | undefined;
  const call: ModelCall = async request => {
    progress(request.stage);
    const response = await modelCall(request);
    options.signal?.throwIfAborted();
    lastResponse = { stage: request.stage, response };
    return response;
  };
  try {
    const expectedState = store.getPaperState(input.paper_id);
    const previous = store.getPaper(input.paper_id);
    const seed = options.seedUncertain ? store.getUncertainPaper(input.paper_id) : null;
    if (options.seedUncertain && !seed) throw new Error('没有可继续定点修正的疑惑版本');
    const { paper, sources: sourceInputs } = await resolvePaper(root, {
      ...previous?.paper,
      ...input,
      sources: input.sources ?? (seed ?? previous)?.sources.map(source => ({ path: source.path, kind: source.kind })),
    });
    if (previous && previous.paper.doi !== paper.doi) throw new Error('已有记录的 DOI 与本次任务不一致');
    const sources = await (options.readSources ?? readSources)(root, sourceInputs, options.signal, { renderImages: true });
    await store.saveArtifact(run, 'sources.json', { paper, sources: sourceManifest(sources) });
    const extractor = new DistillationAgent(call);
    const verifier = new VerificationAgent(request => call(options.reviewFeedback ? { ...request,
      input: JSON.stringify({ ...JSON.parse(request.input), previous_review_feedback: options.reviewFeedback }),
    } : request));
    let draft: Draft;
    let initialOutputError: { message: string; response: string } | undefined;
    try { draft = seed ? structuredClone(seed.draft) : await extractor.extract(paper, sources, options.signal); }
    catch (error) {
      options.signal?.throwIfAborted();
      if (!previous || lastResponse?.stage !== 'distill' || repairAttempts === maxRepairs) throw error;
      initialOutputError = { message: (error as Error).message, response: lastResponse.response };
      await store.saveArtifact(run, 'initial_output_error.json', initialOutputError);
      draft = structuredClone(previous.draft);
    }
    if (seed) await store.saveArtifact(run, 'targeted_from.json', { paper_id: seed.paper.paper_id, revision: seed.revision, verified_at: seed.verified_at, previous_repair_rounds: seed.repair_rounds ?? 0, new_cycle_limit: maxRepairs });
    let best: CheckedCandidate | undefined;
    let pendingFeedback = Boolean(options.requireFeedbackRepair && options.reviewFeedback);
    const publish = async (candidate: CheckedCandidate, uncertain: boolean, extraReason?: string) => {
      options.signal?.throwIfAborted();
      publicationStarted = true;
      const uncertainties = uncertain ? [...new Set([
        ...candidate.review.issues.filter(issue => issue.resolution_status !== 'resolved' && !isSourceLimitationIssue(issue)).map(issue => `${issue.field_path}: ${issue.proposed_correction || issue.current_value}`),
        ...candidate.errors, ...(extraReason ? [extraReason] : []),
        ...(candidate.round !== repairAttempts ? [`选用第${candidate.round}轮已核验版本；后续版本未改善或未能完成核验`] : []),
      ])] : [];
      if (uncertain && !uncertainties.length) uncertainties.push('核验仍存在未解决问题，使用前需复核');
      const matches = matchingEntries(candidate.draft, candidate.review);
      const possibleMatches = matchingEntries(candidate.draft, candidate.review, true)
        .filter(entry => !matches.some(match => match.sample_local_id === entry.sample_local_id && match.phase_local_id === entry.phase_local_id));
      const record: PublishedRecord = {
        schema_version: 1, paper, revision: (previous?.revision ?? 0) + 1,
        verified_at: new Date().toISOString(), verified_by: options.modelLabel ?? 'configured-model',
        verification_status: uncertain ? 'uncertain' : 'verified', repair_rounds: repairAttempts,
        ...(options.distillationModelLabel ? { distilled_by: options.distillationModelLabel } : {}),
        sources: sourceManifest(sources), draft: candidate.draft, verification: candidate.review, match_entries: matches,
        ...(uncertain ? { uncertainties } : {}),
        ...(possibleMatches.length ? { candidate_match_entries: possibleMatches } : {}),
      };
      await store.saveArtifact(run, 'selection.json', { repair_attempts: repairAttempts, selected_round: candidate.round, score: candidate.score, status: record.verification_status });
      await store.saveArtifact(run, 'record.json', deliveryRecord(record));
      options.signal?.throwIfAborted();
      const completed: RunState = { ...run, status: uncertain ? 'published_uncertain' : 'published',
        message: uncertain ? `已入库 ${candidate.draft.samples.length} 条样品记录，标记疑惑，可检索；修正 ${repairAttempts} 次` : `已发布 ${candidate.draft.samples.length} 条样品记录、${matches.length} 条目标相匹配项；修正 ${repairAttempts} 次` };
      store.publish(record, expectedState, completed);
      Object.assign(run, completed);
      return { ...run };
    };
    fallback = async reason => best ? publish(best, true, reason) : finish('needs_review', '修正已达上限，但没有来源已确认且结构可用的版本，未入库');
    let previousReview: Verification | undefined;
    while (true) {
      const round = repairAttempts;
      await store.saveArtifact(run, `draft_${round}.json`, draft);
      let errors = validateDraft(draft, sources);
      const reviewNotes = draftReviewNotes(draft, sources);
      await store.saveArtifact(run, `review_notes_${round}.json`, reviewNotes);
      let review: Verification | null = null;
      // Preserve non-experiment conclusions as run outcomes, never as unverified searchable samples.
      // A source-limited draft with usable samples still passes through normal checks and verification.
      if (['identity_mismatch', 'no_relevant_experiments'].includes(draft.assessment) || !draft.samples.length) {
        await store.saveArtifact(run, `checks_${round}.json`, errors);
        if (errors.length) return finish('needs_review', `草稿校验未通过：${errors.slice(0, 3).join('；')}；未发布实验记录`);
        if (draft.assessment === 'no_relevant_experiments') return finish('skipped', '未发现本论文实际报告的相关制备实验；处理结论已保存，未发布实验记录');
        return finish('needs_review', draft.assessment === 'identity_mismatch'
          ? '论文身份存疑（标题/DOI/内容不一致）；未发布实验记录'
          : '来源不足或没有可核验样品；处理结论已保存，未发布实验记录');
      }
      if (!errors.length) {
        review = await verifier.verify(paper, sources, draft, options.signal, reviewNotes, round > 0 ? previousReview : undefined);
        await store.saveArtifact(run, `verification_${round}.json`, review);
        previousReview = review;
        errors = verificationChecks(review, draft, sources);
        if (reviewNotes.some(note => note.kind === 'derived')) errors.push('草稿仍含模型自行推导的实验值；必须删除或提供原文明示依据后才能发布');
      }
      await store.saveArtifact(run, `checks_${round}.json`, errors);
      let current: CheckedCandidate | undefined;
      if (review && draft.samples.length && review.source_identity === 'confirmed' && !verificationStructureChecks(review, draft, sources).length) {
        current = { draft, review, errors, notes: reviewNotes, round, score: candidateScore(review, reviewNotes) + (pendingFeedback ? 100 : 0) };
        if (!best || current.score <= best.score) best = current;
      }
      if (!pendingFeedback && !initialOutputError && current && !errors.length && !doubts(current.review)) return await publish(current, false);
      if (!pendingFeedback && !initialOutputError && current && !errors.length && !needsRepair(current.review)) return await publish(current, true);
      if (repairAttempts === maxRepairs) {
        // 走完既定的修正轮数（≥2 轮）就发布尽力版本并标疑惑；check-only/distill-only 这类 0 轮或 1 轮不发布。
        if (maxRepairs >= 2) return await fallback();
        return finish('needs_review', `仍有待解决问题：${errors.slice(0, 3).join('；') || '核验存在疑惑'}。未更新可用记录`);
      }
      let repaired = false;
      let repairError: string | undefined;
      while (!repaired && repairAttempts < maxRepairs) {
        repairAttempts++;
        const beforeResponse = lastResponse;
        try {
          const repair = options.focusedRepairs ? extractor.repairFocused.bind(extractor) : extractor.repair.bind(extractor);
          draft = await repair(paper, sources, draft, {
            repair_round: repairAttempts, repair_limit: maxRepairs, final_round: repairAttempts === maxRepairs,
            program_checks: errors, review_notes: reviewNotes, verification: review ? { ...review, issues: review.issues.filter(repairableIssue) } : null, previous_repair_error: repairError,
            ...(initialOutputError ? { initial_output_error: initialOutputError } : {}),
            ...(pendingFeedback ? { targeted_followup_feedback: options.reviewFeedback } : {}),
          }, options.signal);
          initialOutputError = undefined;
          pendingFeedback = false;
          repaired = true;
        } catch (error) {
          options.signal?.throwIfAborted();
          repairError = (error as Error).message;
          await store.saveArtifact(run, `repair_error_${repairAttempts}.json`, { message: repairError, ...(lastResponse !== beforeResponse && lastResponse?.stage === 'repair' ? { response: lastResponse.response } : {}) });
        }
      }
      if (!repaired) return repairAttempts === maxRepairs && maxRepairs >= 2 ? await fallback(repairError) : finish('needs_review', `修正未能形成可检查版本：${repairError}`);
    }
  } catch (error) {
    const cancelled = !!options.signal?.aborted;
    if (lastResponse && !cancelled) await store.saveArtifact(run, 'last_model_output.json', lastResponse);
    if (!cancelled && !publicationStarted && maxRepairs >= 2 && repairAttempts === maxRepairs && fallback) {
      try { return await fallback(`修正后的处理未完成：${(error as Error).message}`); }
      catch (publishError) { return finish('failed', (publishError as Error).message, classifyError(publishError)); }
    }
    return finish(cancelled ? 'cancelled' : 'failed', cancelled ? '任务已取消，未覆盖已有记录' : (error as Error).message, cancelled ? 'cancelled' : classifyError(error));
  } finally { store.close(); }
}
