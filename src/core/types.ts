export type ProviderName = 'shared-llm' | 'decentralized-llm' | 'local-fallback';

export type GenerateOptions = {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

export type GenerateInput = {
  input: string;
  sessionId?: string;
  model?: string;
  options?: GenerateOptions;
  strategy?: 'default' | 'latency-aware';
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type GenerateResult = {
  id: string;
  providerUsed: ProviderName;
  modelUsed?: string;
  output: string;
  usage?: TokenUsage;
  timingMs: number;
};

export type ProviderHealth = {
  name: ProviderName;
  ok: boolean;
  latencyMs?: number;
  error?: string;
};
