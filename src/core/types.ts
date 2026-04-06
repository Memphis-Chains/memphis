import type { RuntimeProvider } from '../providers/runtime.js';

export const PROVIDER_NAMES = [
  'anthropic',
  'shared-llm',
  'decentralized-llm',
  'local-fallback',
  'ollama',
  'minimax',
  'deepseek',
  'glm',
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const REQUESTED_PROVIDER_NAMES = ['auto', ...PROVIDER_NAMES] as const;

export type RequestedProviderName = (typeof REQUESTED_PROVIDER_NAMES)[number];

export type ExecutionMode = 'canonical' | 'provider-only';

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
  totalTokens?: number;
  estimated?: boolean;
};

export type CompactionPressure = {
  level: 'low' | 'medium' | 'high';
  summaryCount: number;
  trimmedMessages: number;
  recentMessages: number;
};

export type RuntimeTelemetry = {
  usage?: TokenUsage;
  contextWindowTokens?: number;
  estimatedPromptTokens?: number;
  remainingContextTokens?: number;
  compactionPressure?: CompactionPressure;
  degraded?: boolean;
  degradationReason?: string;
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
  telemetry?: RuntimeTelemetry;
  timingMs: number;
  trace?: ProviderTrace;
};

export type ProviderHealth = {
  name: ProviderName;
  ok: boolean;
  latencyMs?: number;
  error?: string;
};

export type SearchResult = {
  id: string;
  content: string;
  score: number;
  timestamp: string;
  warning?: string;
  results?: SearchResult[];
};

export type ProviderCascadeResult = {
  provider: RuntimeProvider;
  degraded: boolean;
  tier: 1 | 2 | 3 | 4 | 5;
  originalRequested: string;
  actualProvider: string;
  reason?: string;
};

export type DegradationInfo = {
  degraded: boolean;
  tier?: 1 | 2 | 3 | 4 | 5;
  originalProvider?: string;
  actualProvider: string;
  reason?: string;
};
