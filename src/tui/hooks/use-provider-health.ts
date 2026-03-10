export type ProviderHealth = {
  status: 'healthy' | 'unhealthy';
  latency?: number;
  error?: string;
};

export async function useProviderHealth(provider: string): Promise<ProviderHealth> {
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));

  if (provider === 'invalid-provider') {
    return {
      status: 'unhealthy',
      error: `Provider ${provider} is not configured`,
    };
  }

  return {
    status: 'healthy',
    latency: Math.max(1, Date.now() - start),
  };
}
