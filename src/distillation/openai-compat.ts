import type { AgentRequest, ModelCall } from './agents.ts';
import { imageContent } from './images.ts';

/**
 * OpenAI 兼容端点（第三方网关）。用于核验：拿不到 ChatGPT OAuth 额度时的替代通道，
 * 同一模型（gpt-6.1-sol）、支持 reasoning_effort / vision / prompt 缓存。
 */
export interface OpenAiCompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  effort: 'low' | 'high';
  outputTokens: number;
}

export interface OpenAiCompatMetadata {
  provider: 'openai-compat';
  model: string;
  reasoning: string;
  usage: unknown;
  stop_reason: string;
}

export function openAiCompatConfig(env: NodeJS.ProcessEnv = process.env): OpenAiCompatConfig | null {
  const apiKey = env.OPENASI_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.OPENASI_BASE_URL?.trim() || 'https://api.openasi.bitmiracle.cn/v1').replace(/\/+$/, '');
  const model = env.OPENASI_MODEL?.trim() || 'gpt-6.1-sol';
  const effort = env.OPENASI_EFFORT?.trim() === 'high' ? 'high' : 'low';
  const outputTokens = Number(env.OPENASI_OUTPUT_TOKENS) > 0 ? Number(env.OPENASI_OUTPUT_TOKENS) : 16000;
  return { baseUrl, apiKey, model, effort, outputTokens };
}

export function createOpenAiCompatCall(root: string, config: OpenAiCompatConfig, options: {
  fetch?: typeof fetch;
  onResult?: (metadata: OpenAiCompatMetadata) => void;
} = {}): ModelCall {
  return async (request: AgentRequest) => {
    request.signal?.throwIfAborted();
    if (request.stage !== 'verify') throw new Error('OpenAI 兼容端点仅用于核验');
    const content = request.images?.length
      ? [
          { type: 'text', text: request.input },
          ...await imageContent(root, request.images).then(items => items.map(item => item.type === 'text' ? item : {
            type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.data}`, detail: 'high' },
          })),
        ]
      : request.input;
    const example = '{"source_identity":"confirmed","coverage":"complete","samples":[],"issues":[],"notes":[]}';
    const body = JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: `${request.system}\nJSON结构示例：${example}。这只是格式示例，实际内容按来源与草稿填写。` },
        { role: 'user', content },
      ],
      reasoning_effort: config.effort,
      max_tokens: config.outputTokens,
      response_format: { type: 'json_object' },
    });
    const signal = AbortSignal.any([AbortSignal.timeout(1200000), ...(request.signal ? [request.signal] : [])]);
    const response = await (options.fetch ?? globalThis.fetch)(`${config.baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body,
    });
    if (!response.ok) {
      const hint = response.status === 401 ? '认证失败，请检查 OPENASI_API_KEY' : response.status === 402 ? '余额不足' : response.status === 404 ? '模型不存在或端点错误' : response.status === 429 ? 'rate_limit，稍后重试' : response.status >= 500 ? 'upstream network failure' : '请求被拒绝';
      throw new Error(`OpenAI兼容 HTTP ${response.status}：${hint}`);
    }
    const result = await response.json() as { model?: string; usage?: Record<string, unknown>; choices?: { finish_reason?: string; message?: { content?: string } }[] };
    const choice = result.choices?.[0];
    if (choice?.finish_reason !== 'stop') throw new Error(`OpenAI兼容端点未完整返回 JSON：${choice?.finish_reason ?? 'missing_choice'}`);
    const output = choice.message?.content;
    if (typeof output !== 'string' || !output.trim()) throw new Error('OpenAI兼容端点返回空 JSON，未更新记录');
    options.onResult?.({ provider: 'openai-compat', model: result.model ?? config.model, reasoning: config.effort, usage: result.usage, stop_reason: 'stop' });
    return output;
  };
}

export const OPENAI_COMPAT_LABEL = (config: OpenAiCompatConfig) => `openai-compat/${config.model}:${config.effort}`;
