import { ProviderPolicy } from './provider-policy.js';
import type { LLMProvider } from '../../core/contracts/llm-provider.js';
import { AppError } from '../../core/errors.js';
import {
  PROVIDER_NAMES,
  type GenerateInput,
  type GenerateResult,
  type ProviderName,
  type ProviderTraceAttempt,
  type ProviderCascadeResult,
} from '../../core/types.js';
import { metrics } from '../../infra/logging/metrics.js';
import {
  sanitizeDegradationReason,
  validateProviderName,
} from '../../infra/security/sanitizers.js';
import type { ChatOptions } from '../../providers/index.js';
import {
  normalizeRuntimeProvider,
  type RuntimeProvider,
} from '../../providers/runtime.js';

/**
 * Operator-preferred default cascade order. Anthropic primary, Minimax second
 * fallback, Ollama offline third, local-fallback always-succeeds safety net.
 * Override with MEMPHIS_PROVIDER_CASCADE=comma,separated,list.
 */
export const DEFAULT_PROVIDER_CASCADE: ProviderName[] = [
  'anthropic',
  'minimax',
  'ollama',
  'local-fallback',
];

/**
 * Parse MEMPHIS_PROVIDER_CASCADE env value into a validated list. Every entry
 * must match a known PROVIDER_NAMES value — we fail loud on typos rather than
 * silently skipping, because a wrong cascade means the operator thought they
 * had a fallback they don't actually have.
 */
export function parseCascadeOrder(
  rawValue: string | undefined,
): ProviderName[] {
  if (!rawValue || !rawValue.trim()) return [...DEFAULT_PROVIDER_CASCADE];
  const parts = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (parts.length === 0) return [...DEFAULT_PROVIDER_CASCADE];

  const seen = new Set<ProviderName>();
  const result: ProviderName[] = [];
  for (const part of parts) {
    if (!(PROVIDER_NAMES as readonly string[]).includes(part)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `MEMPHIS_PROVIDER_CASCADE contains unknown provider '${part}'. ` +
          `Valid names: ${PROVIDER_NAMES.join(', ')}`,
        400,
      );
    }
    const name = part as ProviderName;
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  // Always guarantee local-fallback terminates the cascade. Without it, a
  // fully-degraded state throws — that's worse than falling through to safe
  // canned output.
  if (!seen.has('local-fallback')) result.push('local-fallback');
  return result;
}

export type OrchestratorDeps = {
  defaultProvider: ProviderName;
  providers: Array<RuntimeProvider | LLMProvider>;
  fallbackProvider?: ProviderName;
  maxRetries?: number;
  providerCooldownMs?: number;
  /** Ordered cascade of providers to try after the requested one. Defaults to DEFAULT_PROVIDER_CASCADE. */
  cascadeOrder?: ProviderName[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  return (
    error.code === 'PROVIDER_TIMEOUT' ||
    error.code === 'PROVIDER_UNAVAILABLE' ||
    error.code === 'PROVIDER_RATE_LIMIT'
  );
}

export class OrchestrationService {
  private readonly providers = new Map<ProviderName, RuntimeProvider>();
  private readonly maxRetries: number;
  private readonly providerPolicy: ProviderPolicy;
  private readonly cascadeOrder: ProviderName[];

  constructor(private readonly deps: OrchestratorDeps) {
    for (const provider of deps.providers) {
      const normalized = normalizeRuntimeProvider(provider);
      this.providers.set(normalized.name, normalized);
    }
    this.maxRetries = deps.maxRetries ?? 2;
    this.providerPolicy = new ProviderPolicy(deps.providerCooldownMs ?? 30_000);
    this.cascadeOrder =
      deps.cascadeOrder && deps.cascadeOrder.length > 0
        ? [...deps.cascadeOrder]
        : [...DEFAULT_PROVIDER_CASCADE];
  }

  /** Read-only view of the configured cascade order (for /status + tests). */
  public getCascadeOrder(): ProviderName[] {
    return [...this.cascadeOrder];
  }

  private pickAutoProvider(strategy: 'default' | 'latency-aware'): ProviderName {
    if (strategy === 'default') return this.deps.defaultProvider;

    const available = [...this.providers.keys()].filter(
      (name) => !this.providerPolicy.isInCooldown(name),
    );
    if (available.length === 0) return this.deps.defaultProvider;

    const stats = metrics.snapshot().providers;
    const ordered = [...available].sort((a, b) => {
      const sa = stats.find((s) => s.provider === a);
      const sb = stats.find((s) => s.provider === b);
      const la = sa?.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
      const lb = sb?.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
      return la - lb;
    });

    return ordered[0] ?? this.deps.defaultProvider;
  }

  public resolveProvider(
    requested?: 'auto' | ProviderName,
    strategy: 'default' | 'latency-aware' = 'default',
  ): RuntimeProvider {
    const providerName =
      requested && requested !== 'auto' ? requested : this.pickAutoProvider(strategy);
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new AppError('PROVIDER_UNAVAILABLE', `Provider not configured: ${providerName}`, 503);
    }

    if (this.providerPolicy.isInCooldown(providerName)) {
      throw new AppError('PROVIDER_UNAVAILABLE', `Provider in cooldown: ${providerName}`, 503, {
        remainingCooldownMs: this.providerPolicy.remainingCooldownMs(providerName),
      });
    }

    return provider;
  }

  public resolveRuntimeProvider(
    requested?: 'auto' | ProviderName,
    strategy: 'default' | 'latency-aware' = 'default',
  ): RuntimeProvider {
    // Use cascade internally - existing callers get resilience automatically
    const cascade = this.resolveProviderCascade(requested, strategy);
    return cascade.provider;
  }

  /**
   * Resolve provider via cascade walk: [requested, defaultProvider, ...cascadeOrder]
   * deduped. Tier is the 1-indexed position in the walk. Tier 1 is the first
   * slot (the requested provider if explicit, or the default otherwise). Later
   * tiers are whichever position in the cascade actually served the request.
   *
   * Operator default cascade: anthropic → minimax → ollama → local-fallback
   * (see DEFAULT_PROVIDER_CASCADE). Override with MEMPHIS_PROVIDER_CASCADE.
   *
   * NEVER throws when local-fallback is registered (which parseCascadeOrder
   * guarantees). Sanitizes all degradation reasons before returning.
   */
  private resolveProviderCascade(
    requested?: 'auto' | ProviderName,
    strategy: 'default' | 'latency-aware' = 'default',
  ): ProviderCascadeResult {
    let resolvedRequested: ProviderName =
      requested && requested !== 'auto' ? requested : this.pickAutoProvider(strategy);

    // SECURITY: reject path-traversal/injection attempts in provider names.
    if (!validateProviderName(resolvedRequested)) {
      resolvedRequested = 'local-fallback';
    }

    // Build the walk list: requested first (tier 1), then default provider
    // as a safety net (preserves behaviour for operators whose default isn't
    // in cascadeOrder), then the full cascade. Dedupe preserves first-seen
    // position so tier numbers are stable.
    const walk: ProviderName[] = [];
    const seen = new Set<ProviderName>();
    const push = (name: ProviderName): void => {
      if (!seen.has(name)) {
        seen.add(name);
        walk.push(name);
      }
    };
    push(resolvedRequested);
    push(this.deps.defaultProvider);
    for (const name of this.cascadeOrder) push(name);
    // local-fallback is the always-succeeds terminator; make sure it's in the
    // walk even if the operator omitted it from cascadeOrder and default.
    push('local-fallback');

    const skipReasons: string[] = [];
    for (let i = 0; i < walk.length; i += 1) {
      const name = walk[i];
      const provider = this.providers.get(name);
      if (!provider) {
        skipReasons.push(`${name} unavailable`);
        continue;
      }
      if (this.providerPolicy.isInCooldown(name)) {
        skipReasons.push(
          `${name} in cooldown (${this.providerPolicy.remainingCooldownMs(name)}ms remaining)`,
        );
        continue;
      }
      const tier = i + 1;
      const degraded = tier > 1;
      return {
        provider,
        degraded,
        tier,
        originalRequested: resolvedRequested,
        actualProvider: name,
        reason: degraded
          ? sanitizeDegradationReason(
              skipReasons.length > 0
                ? skipReasons.join('; ')
                : `all providers unavailable, using ${name}`,
            )
          : undefined,
      };
    }

    // Only reachable if local-fallback isn't registered at all — treat as a
    // runtime-misconfig rather than silently returning something invalid.
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'Critical: cascade exhausted — local-fallback not registered',
      503,
    );
  }

  /**
   * Public API for getting cascade result with degradation info
   */
  public getCascadeResult(
    requested?: 'auto' | ProviderName,
    strategy: 'default' | 'latency-aware' = 'default',
  ): ProviderCascadeResult {
    return this.resolveProviderCascade(requested, strategy);
  }

  public async chat(
    input: GenerateInput & { provider?: 'auto' | ProviderName },
  ): Promise<GenerateResult> {
    if ((process.env.MEMPHIS_SAFE_MODE ?? '').toLowerCase() === 'true') {
      throw new AppError('PERMISSION_DENIED', 'forbidden in safe mode: generation is disabled', 403);
    }

    if (!input.messages || input.messages.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'messages[] is required for chat()', 400);
    }

    const started = Date.now();
    const provider = this.resolveRuntimeProvider(input.provider, input.strategy ?? 'default');

    const opts: ChatOptions = {
      model: input.model,
      temperature: input.options?.temperature,
      maxTokens: input.options?.maxTokens,
      systemPrompt: input.systemPrompt,
      tools: input.tools as ChatOptions['tools'],
    };

    const response = await provider.chat(input.messages as import('../../providers/index.js').ChatMessage[], opts);

    return {
      id: `gen_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
      providerUsed: provider.name as ProviderName,
      modelUsed: response.model,
      output: response.content,
      usage: response.tokens
        ? {
            inputTokens: response.tokens.prompt,
            outputTokens: response.tokens.completion,
            totalTokens: response.tokens.total,
            estimated: response.tokens.estimated,
          }
        : undefined,
      timingMs: Date.now() - started,
    };
  }

  private async tryGenerateWithRetry(
    provider: RuntimeProvider,
    input: GenerateInput,
    trace: ProviderTraceAttempt[],
    viaFallback: boolean,
  ): Promise<GenerateResult> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      const started = Date.now();
      try {
        const out = await provider.generate(input);
        const latencyMs = Date.now() - started;
        metrics.recordProviderCall(provider.name, true, latencyMs);
        this.providerPolicy.markSuccess(provider.name);
        trace.push({
          attempt: attempt + 1,
          provider: provider.name,
          viaFallback,
          ok: true,
          latencyMs,
        });
        return out;
      } catch (error) {
        const latencyMs = Date.now() - started;
        metrics.recordProviderCall(provider.name, false, latencyMs);
        this.providerPolicy.markFailure(provider.name);
        trace.push({
          attempt: attempt + 1,
          provider: provider.name,
          viaFallback,
          ok: false,
          latencyMs,
          errorCode: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        lastError = error;
        if (!isRetryable(error) || attempt === this.maxRetries) {
          break;
        }

        const backoffMs = Math.min(300 * 2 ** attempt + Math.floor(Math.random() * 100), 2000);
        await sleep(backoffMs);
        attempt += 1;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AppError('INTERNAL_ERROR', 'Unknown generate error', 500);
  }

  public async generate(
    input: GenerateInput & { provider?: 'auto' | ProviderName },
  ): Promise<GenerateResult> {
    if ((process.env.MEMPHIS_SAFE_MODE ?? '').toLowerCase() === 'true') {
      throw new AppError(
        'PERMISSION_DENIED',
        'forbidden in safe mode: generation is disabled',
        403,
      );
    }
    let primary: RuntimeProvider | undefined;
    const trace: ProviderTraceAttempt[] = [];

    try {
      primary = this.resolveProvider(input.provider, input.strategy ?? 'default');
      const out = await this.tryGenerateWithRetry(primary, input, trace, false);
      return {
        ...out,
        trace: {
          strategy: input.strategy ?? 'default',
          requestedProvider: input.provider ?? 'auto',
          attempts: trace,
        },
      };
    } catch (primaryError) {
      const fallbackName = this.deps.fallbackProvider;
      if (!fallbackName) {
        throw primaryError;
      }

      const fallback = this.providers.get(fallbackName);
      if (!fallback) {
        throw primaryError;
      }

      if (this.providerPolicy.isInCooldown(fallbackName)) {
        throw new AppError('PROVIDER_UNAVAILABLE', `Fallback provider in cooldown: ${fallbackName}`, 503);
      }

      if (primary && fallback.name === primary.name) {
        throw primaryError;
      }

      const out = await this.tryGenerateWithRetry(fallback, input, trace, true);
      return {
        ...out,
        trace: {
          strategy: input.strategy ?? 'default',
          requestedProvider: input.provider ?? 'auto',
          attempts: trace,
        },
      };
    }
  }

  public async providersHealth() {
    const providerList = [...this.providers.values()];
    const checks = await Promise.allSettled(providerList.map((provider) => provider.healthCheck()));

    return checks.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }

      const provider = providerList[idx];
      return {
        name: provider.name,
        ok: false,
        error: result.reason instanceof Error ? result.reason.message : 'Unknown provider error',
      };
    });
  }

  /**
   * Per-provider model inventory. For live providers (ollama with /api/tags,
   * anthropic with static list, etc.) returns whatever listModels() exposes.
   * Providers that are unreachable return an empty array rather than throwing.
   */
  public async providersModels(): Promise<Record<string, string[]>> {
    const entries = [...this.providers.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([name, provider]) => [name, await provider.listModels()] as const),
    );
    const out: Record<string, string[]> = {};
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      const [name] = entries[i];
      out[name] = result.status === 'fulfilled' ? result.value[1] : [];
    }
    return out;
  }

  /**
   * Returns the configured primary provider name.
   * Used by doctor-v2 Tier A (Architecture Health) checks.
   */
  public getPrimaryProvider(): ProviderName {
    return this.deps.defaultProvider;
  }

  /**
   * Returns the configured fallback provider name, or undefined if none.
   * Used by doctor-v2 Tier A (Architecture Health) checks.
   */
  public getFallbackProvider(): ProviderName | undefined {
    return this.deps.fallbackProvider;
  }

  /**
   * Returns the internal ProviderPolicy for read-only inspection.
   * Used by doctor-v2 Tier A (Architecture Health) checks.
   */
  public getProviderPolicy(): ProviderPolicy {
    return this.providerPolicy;
  }
}
