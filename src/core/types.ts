export type ProviderName =
  | 'shared-llm'
  | 'decentralized-llm'
  | 'local-fallback'
  | 'ollama'
  | 'minimax'
  | 'deepseek'
  | 'glm';

export type GenerateOptions = {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }
  | { role: 'tool'; tool_call_id: string; content: string };

export type GenerateInput = {
  input?: string;
  messages?: ChatMessage[];
  systemPrompt?: string;
  userId?: string;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  sessionId?: string;
  model?: string;
  options?: GenerateOptions;
  strategy?: 'default' | 'latency-aware';
  execution?: {
    taskId: string;
    runId: string;
    source: string;
    enableReplayDedupe?: boolean;
  };
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type ProviderTraceAttempt = {
  attempt: number;
  provider: ProviderName;
  viaFallback: boolean;
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
};

export type ProviderTrace = {
  strategy: 'default' | 'latency-aware';
  requestedProvider: 'auto' | ProviderName;
  attempts: ProviderTraceAttempt[];
};

export type GenerateResult = {
  id: string;
  providerUsed: ProviderName;
  modelUsed?: string;
  output: string;
  usage?: TokenUsage;
  timingMs: number;
  trace?: ProviderTrace;
};

export type ProviderHealth = {
  name: ProviderName;
  ok: boolean;
  latencyMs?: number;
  error?: string;
};
