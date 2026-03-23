export type ProviderHealth = {
  status: 'healthy' | 'unhealthy' | 'unknown';
  latency?: number;
  error?: string;
};

/**
 * Check provider health by pinging its API endpoint.
 *
 * TODO: Wire to real provider health check (e.g. orchestration.providersHealth())
 * once the TUI has access to the DI container. Currently returns 'unknown' to
 * avoid misleading operators with fake healthy status.
 */
export async function useProviderHealth(provider: string): Promise<ProviderHealth> {
  if (provider === 'invalid-provider') {
    return {
      status: 'unhealthy',
      error: `Provider ${provider} is not configured`,
    };
  }

  // Real health check not yet wired — return unknown instead of fake healthy
  return {
    status: 'unknown',
  };
}
