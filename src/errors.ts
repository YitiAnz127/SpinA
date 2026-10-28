export type ErrorKind = 'cancelled' | 'timeout' | 'quota' | 'network' | 'structure' | 'source' | 'other';
const kinds = new Set<string>(['cancelled', 'timeout', 'quota', 'network', 'structure', 'source', 'other']);

export class SpinaError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
    this.name = 'SpinaError';
  }
}

/** Structured errors take precedence; message matching is only for provider/legacy boundaries. */
export function classifyError(error: unknown): ErrorKind {
  const seen = new Set<unknown>();
  const classify = (value: unknown): ErrorKind => {
    if (seen.has(value)) return 'other';
    seen.add(value);
    const e = value && typeof value === 'object'
      ? value as { kind?: string; error_kind?: string; name?: string; code?: string; status?: number; statusCode?: number; message?: string; cause?: unknown }
      : { message: String(value ?? '') };
    const kind = e.kind ?? e.error_kind;
    if (kind && kinds.has(kind)) return kind as ErrorKind;
    const message = e.message ?? '';
    const status = e.status ?? e.statusCode ?? Number(/\b(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*(\d{3})\b/i.exec(message)?.[1]);
    if (status === 429) return 'quota';
    if (status === 408 || status === 504) return 'timeout';
    if (status >= 500 && status < 600) return 'network';
    if (status >= 400 && status < 500) return 'other';
    if (e.name === 'TimeoutError' || e.code === 'ETIMEDOUT' || /\b(?:timed?\s*out|timeout)\b|超时/i.test(message)) return 'timeout';
    if (e.name === 'AbortError' || /\b(?:cancelled|canceled|aborted)\b|用户取消|任务已取消/i.test(message)) return 'cancelled';
    if (e.name === 'SyntaxError' || /模型输出不符合结构|未完整返回 JSON|空 JSON|定点修正|\bJSON\b.*(?:parse|position)|(?:Expected|Unexpected).*\bJSON\b/i.test(message)) return 'structure';
    if (/usage[ ._-]?limit|quota|rate[ _-]?limit|requests per|too many requests/i.test(message)) return 'quota';
    if (/^(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_SOCKET)$/.test(e.code ?? '') || /fetch failed|network error|socket hang|ECONNRESET|ECONNREFUSED|upstream network/i.test(message)) return 'network';
    if (e.code === 'ENOENT' || /只有 SI|尚缺正文|没有可读文本层|不是 PDF|论文必须是小于|来源已改变|来源不足|来源版本|来源未取得/i.test(message)) return 'source';
    return e.cause ? classify(e.cause) : 'other';
  };
  return classify(error);
}
