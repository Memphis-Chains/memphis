import { ProviderPolicy } from './provider-policy.js';
import type { LLMProvider } from '../../core/contracts/llm-provider.js';
import { AppError } from '../../core/errors.js';
import type {
  GenerateInput,
  GenerateResult,
  ProviderName,
  ProviderTraceAttempt,
  ProviderCascadeResult,
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

export type OrchestratorDeps = {
  defaultProvider: ProviderName;
  providers: Array<RuntimeProvider | LLMProvider>;
  fallbackProvider?: ProviderName;
  maxRetries?: number;
  providerCooldownMs?: number;
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

  constructor(private readonly deps: OrchestratorDeps) {
    for (const provider of deps.providers) {
      const normalized = normalizeRuntimeProvider(provider);
      this.providers.set(normalized.name, normalized);
    }
    this.maxRetries = deps.maxRetries ?? 2;
    this.providerPolicy = new ProviderPolicy(deps.providerCooldownMs ?? 30_000);
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
   * Resolve provider with 5-tier cascade: requested → default → minimax → ollama → local-fallback
   *
   * NOTE: The cascade order is: requested -> default -> minimax -> ollama -> local-fallback
   * This ensures minimax is always tried before ollama when default (usually minimax) fails.
   * TODO(#36): Make cascade order configurable via provider priority list.
   * NEVER throws - always returns a provider
   * Security: Validates provider names, sanitizes degradation reasons
   */
  private resolveProviderCascade(
    requested?: 'auto' | ProviderName,
    strategy: 'default' | 'latency-aware' = 'default',
  ): ProviderCascadeResult {
    // Resolve requested provider name
    let requestedName =
      requested && requested !== 'auto' ? requested : this.pickAutoProvider(strategy);

    // SECURITY: Validate provider name before lookup
    if (!validateProviderName(requestedName)) {
      // Log suspicious provider name and fall back to safe default
      requestedName = 'local-fallback';
    }

    // Tier 1: Try requested provider
    const requestedProvider = this.providers.get(requestedName);
    if (requestedProvider && !this.providerPolicy.isInCooldown(requestedName)) {
      return {
        provider: requestedProvider,
        degraded: false,
        tier: 1,
        originalRequested: requestedName,
        actualProvider: requestedName,
      };
    }

    // Tier 1 failed - build reason
    const tier1Reason = requestedProvider
      ? sanitizeDegradationReason(
          `${requestedName} in cooldown (${this.providerPolicy.remainingCooldownMs(requestedName)}ms remaining)`,
        )
      : sanitizeDegradationReason(`${requestedName} unavailable`);

    // Tier 2: Try default provider (if different from requested)
    const defaultName = this.deps.defaultProvider;
    if (defaultName !== requestedName) {
      const defaultProvider = this.providers.get(defaultName);
      if (defaultProvider && !this.providerPolicy.isInCooldown(defaultName)) {
        return {
          provider: defaultProvider,
          degraded: true,
          tier: 2,
          originalRequested: requestedName,
          actualProvider: defaultName,
          reason: tier1Reason,
        };
      }
    }

    // Tier 3: Try minimax specifically (if not already tried as default)
    // This ensures minimax is in the cascade before ollama
    if (defaultName !== 'minimax' && requestedName !== 'minimax') {
      const minimaxProvider = this.providers.get('minimax');
      if (minimaxProvider && !this.providerPolicy.isInCooldown('minimax')) {
        return {
          provider: minimaxProvider,
          degraded: true,
          tier: 3,
          originalRequested: requestedName,
          actualProvider: 'minimax',
          reason: sanitizeDegradationReason(`${requestedName} and ${defaultName} unavailable, trying minimax`),
        };
      }
    }

    // Tier 4: Try ollama (local)
    const ollamaProvider = this.providers.get('ollama');
    if (ollamaProvider && !this.providerPolicy.isInCooldown('ollama') && requestedName !== 'ollama') {
      return {
        provider: ollamaProvider,
        degraded: true,
        tier: 4,
        originalRequested: requestedName,
        actualProvider: 'ollama',
        reason: sanitizeDegradationReason(`${requestedName} and ${defaultName} unavailable, using ollama`),
      };
    }

    // Tier 5: local-fallback (always succeeds)
    const fallbackProvider = this.providers.get('local-fallback');
    if (!fallbackProvider) {
      // This should never happen in production, but handle it defensively
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'Critical: local-fallback provider not configured',
        503,
      );
    }

    return {
      provider: fallbackProvider,
      degraded: true,
      tier: 5,
      originalRequested: requestedName,
      actualProvider: 'local-fallback',
      reason: sanitizeDegradationReason('all providers unavailable, using local-fallback'),
    };
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
