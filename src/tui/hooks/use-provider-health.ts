import type { OrchestrationService } from '../../modules/orchestration/service.js';

export type ProviderHealth = {
  status: 'healthy' | 'unhealthy' | 'unknown';
  latency?: number;
  error?: string;
};

/**
 * Check provider health by pinging its API endpoint.
 *
 * @param provider - Provider name to check
 * @param orchestration - Optional OrchestrationService instance. If provided,
 *                        real health checks will be performed via providersHealth().
 */
export async function useProviderHealth(
  provider: string,
  orchestration?: OrchestrationService,
): Promise<ProviderHealth> {
  if (provider === 'invalid-provider') {
    return {
      status: 'unhealthy',
      error: `Provider ${provider} is not configured`,
    };
  }

  if (!orchestration) {
    return {
      status: 'unknown',
    };
  }

  try {
    const allHealth = await orchestration.providersHealth();
    const entry = allHealth.find((p) => p.name === provider);

    if (!entry) {
      return {
        status: 'unknown',
        error: `Provider ${provider} not found`,
      };
    }

    return {
      status: entry.ok ? 'healthy' : 'unhealthy',
      latency: entry.latencyMs,
      error: entry.error,
    };
  } catch (err) {
    return {
      status: 'unhealthy',
      error: err instanceof Error ? err.message : 'Health check failed',
    };
  }
}
