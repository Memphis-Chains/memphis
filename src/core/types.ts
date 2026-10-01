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
  | {
      role: 'assistant';
      content: string;
      tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    }
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

/**
 * Credential state, independent of whether the provider answered.
 *
 * Every `isAvailable()` implementation in this codebase returns
 * `isConfigured()` (a tautology — see the audit in journal-633), so
 * `ProviderHealth.ok` has always meant "a key is present in the
 * environment", not "the key works". Measured 2026-10-01: an
 * `ANTHROPIC_API_KEY=sk-test` placeholder produced `ok: true,
 * latencyMs: 3` from `/v1/providers/health` while a real POST to
 * `api.anthropic.com/v1/messages` returned HTTP 401 in 280 ms.
 *
 * That distinction matters during a cascade: when the primary provider
 * fails, the orchestrator walks the fallback list and burns a round trip
 * per dead provider before reaching a working one. `credentialState`
 * lets the operator (and future cascade logic) tell the two cases apart
 * without having to issue a test request.
 *
 * - `missing`  — no key at all; provider is not registered.
 * - `present`  — a non-empty key exists. Not verified against the
 *                remote endpoint (that is what `ok` still reports).
 * - `placeholder` — a non-empty key that matches a known scaffold value
 *                (`sk-test`, `changeme`, `xxx`, ...). These are always
 *                `ok: true` under the old check and always fail in
 *                production; flagging them lets `/providers` explain
 *                why a cascade skips a provider.
 */
export type ProviderCredentialState = 'missing' | 'present' | 'placeholder';

export type ProviderHealth = {
  name: ProviderName;
  ok: boolean;
  latencyMs?: number;
  error?: string;
  /**
   * Whether a usable credential is present. Absent on providers that
   * need no key (local-fallback, ollama) — `ok` remains the authority
   * for those.
   */
  credentialState?: ProviderCredentialState;
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
  /** 1-indexed position in the cascade walk. Tier 1 = first try (requested or head of cascade). */
  tier: number;
  originalRequested: string;
  actualProvider: string;
  reason?: string;
};

export type DegradationInfo = {
  degraded: boolean;
  tier?: number;
  originalProvider?: string;
  actualProvider: string;
  reason?: string;
};
