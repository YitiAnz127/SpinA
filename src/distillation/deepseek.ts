import type { AgentRequest, ModelCall } from './agents.ts';
import { imageContent } from './images.ts';
import { readStoredCredential } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js';

export interface DeepSeekConfig {
  apiKey: string;
  model: 'deepseek-flash' | 'deepseek-v4-pro';
  effort: 'low' | 'high' | 'max';
}
export interface DeepSeekMetadata {
  provider: 'deepseek'; model: string; reasoning: string;
  usage: unknown; stop_reason: string;
}

export function deepSeekConfig(env: NodeJS.ProcessEnv = process.env, storedApiKey?: string | null): DeepSeekConfig {
  let apiKey = env.DEEPSEEK_API_KEY?.trim() || storedApiKey?.trim();
  if (!apiKey && storedApiKey === undefined) {
    const credential = readStoredCredential('deepseek');
    if (credential?.type === 'api_key' && credential.key && !credential.key.startsWith('!')) apiKey = env[credential.key]?.trim() || credential.key.trim();
  }
  if (!apiKey) throw new Error('请先在 SpinA /login 中配置 DeepSeek API Key，或设置 DEEPSEEK_API_KEY');
  const model = env.SPINA_DISTILL_MODEL ?? 'deepseek-flash';
  const effort = env.SPINA_DISTILL_EFFORT ?? 'high';
  if (model !== 'deepseek-flash' && model !== 'deepseek-v4-pro') throw new Error('SPINA_DISTILL_MODEL 必须为 deepseek-flash 或 deepseek-v4-pro');
  if (effort !== 'low' && effort !== 'high' && effort !== 'max') throw new Error('SPINA_DISTILL_EFFORT 必须为 low、high 或 max；DeepSeek 的 medium 实际映射为 high');
  return { apiKey, model, effort };
}

export function createDeepSeekCall(root: string, config: DeepSeekConfig, options: {
  fetch?: typeof fetch;
  onResult?: (metadata: DeepSeekMetadata) => void;
} = {}): ModelCall {
  return async request => {
    request.signal?.throwIfAborted();
    if (request.stage === 'verify') throw new Error('DeepSeek 接口仅负责蒸馏和修正');
    if (request.images?.length && config.model !== 'deepseek-flash') throw new Error('deepseek-v4-pro 不支持页图输入；请使用 deepseek-flash，不能静默丢弃来源图像');
    const text = request.system + request.input;
    const estimate = Math.ceil([...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 127 ? 1.5 : 1 / 3), 0));
    const outputBudget = 65536; // Includes thinking tokens; only final JSON enters the pipeline.
    if (estimate + (request.images?.length ?? 0) * 1024 + outputBudget > 1_000_000) throw new Error('来源超过 DeepSeek 上下文容量；不会截断原文');
    const content = request.images?.length ? [
      { type: 'text', text: request.input },
      ...await imageContent(root, request.images).then(items => items.map(item => item.type === 'text' ? item : {
        type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.data}`, detail: 'original' },
      })),
    ] : request.input;
    const example = request.outputShape === 'patch' ? '{"patches":[]}' : '{"assessment":"no_relevant_experiments","samples":[]}';
    const body = JSON.stringify({
      model: config.model, stream: false,
      messages: [{ role: 'system', content: request.system + `\nJSON结构示例：${example}。这只是格式示例，实际内容按来源与核验反馈填写。` }, { role: 'user', content }],
      thinking: { type: 'enabled' }, reasoning_effort: config.effort,
      max_tokens: outputBudget, response_format: { type: 'json_object' },
    });
    if (Buffer.byteLength(body) > 48 * 1024 * 1024) throw new Error('DeepSeek 请求超过 48 MiB；不会截断来源或丢弃页图');
    const signal = AbortSignal.any([AbortSignal.timeout(1200000), ...(request.signal ? [request.signal] : [])]);
    const response = await (options.fetch ?? globalThis.fetch)('https://api.deepseek.com/chat/completions', {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body,
    });
    if (!response.ok) {
      const hint = response.status === 401 ? '认证失败，请检查 DEEPSEEK_API_KEY' : response.status === 402 ? '余额不足，请检查 DeepSeek 账户' : response.status === 429 ? 'rate_limit，稍后重试' : response.status >= 500 ? 'upstream network failure' : '请求被拒绝，请检查参数';
      throw new Error(`DeepSeek HTTP ${response.status}：${hint}`);
    }
    const result = await response.json() as { model?: string; usage?: unknown; choices?: { finish_reason?: string; message?: { content?: string } }[] };
    const choice = result.choices?.[0];
    if (choice?.finish_reason !== 'stop') throw new Error(`DeepSeek 未完整返回 JSON：${choice?.finish_reason ?? 'missing_choice'}`);
    const output = choice.message?.content;
    if (typeof output !== 'string' || !output.trim()) throw new Error('DeepSeek 返回空 JSON，未更新记录');
    options.onResult?.({ provider: 'deepseek', model: result.model ?? config.model, reasoning: config.effort, usage: result.usage, stop_reason: 'stop' });
    return output;
  };
}

export function routeDistillationCalls(extractor: ModelCall, verifier: ModelCall): ModelCall {
  return (request: AgentRequest) => request.stage === 'verify' ? verifier(request) : extractor(request);
}
