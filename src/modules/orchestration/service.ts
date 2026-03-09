import { AppError } from '../../core/errors.js';
import type { LLMProvider } from '../../core/contracts/llm-provider.js';
import type { GenerateInput, GenerateResult, ProviderName, ProviderTraceAttempt } from '../../core/types.js';
import { metrics } from '../../infra/logging/metrics.js';
import { ProviderPolicy } from './provider-policy.js';

export type OrchestratorDeps = {
  defaultProvider: ProviderName;
  providers: LLMProvider[];
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
  private readonly providers = new Map<ProviderName, LLMProvider>();
  private readonly maxRetries: number;
  private readonly providerPolicy: ProviderPolicy;

  constructor(private readonly deps: OrchestratorDeps) {
    for (const provider of deps.providers) {
      this.providers.set(provider.name, provider);
    }
    this.maxRetries = deps.maxRetries ?? 2;
    this.providerPolicy = new ProviderPolicy(deps.providerCooldownMs ?? 30_000);
  }

  private pickAutoProvider(strategy: 'default' | 'latency-aware'): ProviderName {
    if (strategy === 'default') return this.deps.defaultProvider;

    const available = [...this.providers.keys()].filter((name) => !this.providerPolicy.isInCooldown(name));
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

  public resolveProvider(requested?: 'auto' | ProviderName, strategy: 'default' | 'latency-aware' = 'default'): LLMProvider {
    const providerName = requested && requested !== 'auto' ? requested : this.pickAutoProvider(strategy);
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

  private async tryGenerateWithRetry(
    provider: LLMProvider,
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
        trace.push({ attempt: attempt + 1, provider: provider.name, viaFallback, ok: true, latencyMs });
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

    throw lastError instanceof Error ? lastError : new AppError('INTERNAL_ERROR', 'Unknown generate error', 500);
  }

  public async generate(input: GenerateInput & { provider?: 'auto' | ProviderName }): Promise<GenerateResult> {
    let primary: LLMProvider | undefined;
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
}
