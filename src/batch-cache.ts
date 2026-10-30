import type { DeepSeekConfig } from './distillation/deepseek.ts';
import type { SourceVersion } from './distillation/source-version.ts';
import type { AgentRequest } from './distillation/agents.ts';
import { applyFocusedRepair, parseDraft, parseVerification } from './distillation/schema.ts';
import { SpinaError } from './errors.ts';
import { createHash } from 'node:crypto';

interface SavedExtraction {
  metadata: { provider: string; stop_reason: string; model: string; reasoning: string };
  output: string;
  source_versions?: SourceVersion[];
}
interface CallCache {
  source_versions: SourceVersion[];
  requests: { stage: string; output: string; metadata: SavedExtraction['metadata'] }[];
}

export function batchRequestKey(system: string, input: string): string {
  return createHash('sha256').update(JSON.stringify([system, input])).digest('hex');
}

/** Migrate legacy cache entries without retaining duplicate source text. */
export function compactCallCache<T extends { requests: { system?: string; input?: string; request_key?: string }[] }>(cache: T): T {
  return { ...cache, requests: cache.requests.map(({ system, input, ...entry }) => ({
    ...entry, request_key: typeof system === 'string' && typeof input === 'string' ? batchRequestKey(system, input) : entry.request_key,
  })).slice(-32) } as T;
}

export function sameSourceVersions(saved: SourceVersion[] | undefined, current: SourceVersion[]): boolean {
  return Boolean(saved?.length && saved.every(v => typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256)) &&
    JSON.stringify(saved) === JSON.stringify(current));
}

/** A missing cache is not proof that a separately saved draft used today's source files. */
export function checkedExtraction(saved: SavedExtraction | null, cache: CallCache | null, current: SourceVersion[]): SavedExtraction {
  if (!saved || saved.metadata?.provider !== 'deepseek' || saved.metadata.stop_reason !== 'stop' || typeof saved.output !== 'string') throw new Error('没有可检查的完整 DeepSeek 草稿');
  const provenByCache = sameSourceVersions(cache?.source_versions, current) && cache!.requests.some(request =>
    request.stage === 'distill' && request.output === saved.output &&
    request.metadata?.provider === saved.metadata.provider && request.metadata.model === saved.metadata.model &&
    request.metadata.reasoning === saved.metadata.reasoning && request.metadata.stop_reason === 'stop');
  if (!sameSourceVersions(saved.source_versions, current) && !(saved.source_versions === undefined && provenByCache)) throw new Error('来源已改变或旧草稿缺少可验证的来源版本，不能复用旧草稿检查');
  return saved;
}

export function batchModelKey(stage: string, verifierLabel: string, config: DeepSeekConfig): string {
  return stage === 'verify' ? verifierLabel : `deepseek/${config.model}:${stage === 'repair' ? config.repairEffort : config.effort}`;
}

export function validateBatchOutput(request: Pick<AgentRequest, 'stage' | 'input' | 'outputShape'>, output: string): void {
  try {
    if (request.stage === 'verify') parseVerification(output);
    else if (request.outputShape === 'patch') applyFocusedRepair(output, parseDraft(JSON.stringify(JSON.parse(request.input).draft)));
    else parseDraft(output);
  } catch (error) {
    throw new SpinaError('structure', (error as Error).message, { cause: error });
  }
}
