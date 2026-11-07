// Evaluation guard: retain the real SpinA extension and its read-only answering tools.
const allowed = new Set(['get_distillation_result', 'get_sample_preparation', 'get_preparation_evidence', 'search_spinel_experiments', 'search_preparation_conditions']);
export default function answerOnly(pi) {
  pi.on('session_start', () => pi.setActiveTools([...allowed]));
  pi.on('tool_call', event => allowed.has(event.toolName) ? undefined : { block: true, reason: '本次只评测回答；禁止蒸馏、返工、索引写入和原件提取。' });
}
