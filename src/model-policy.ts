/** Independent from the model selected interactively for the current Pi session. */
export const SOL_POLICY = {
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  reasoning: 'low',
  outputTokens: 16000,
} as const;

export const SOL_LABEL = `${SOL_POLICY.provider}/${SOL_POLICY.model}:${SOL_POLICY.reasoning}`;
