import type { ProviderHealth } from '../../core/types.js';

export type HealthColor = 'green' | 'yellow' | 'red';

export function computeHealthColor(input: {
  providers: ProviderHealth[];
  uptimeSec: number;
}): HealthColor {
  const total = input.providers.length;
  const healthy = countHealthyProviders(input.providers);
  return computeHealthColorFromCounts(healthy, total);
}

export function computeHealthSummary(input: { providers: ProviderHealth[]; uptimeSec: number }) {
  const healthy = countHealthyProviders(input.providers);
  const total = input.providers.length;
  const color = computeHealthColorFromCounts(healthy, total);

  return {
    color,
    message:
      color === 'green'
        ? `All providers healthy (${healthy}/${total})`
        : color === 'yellow'
          ? `Partial provider health (${healthy}/${total})`
          : `No healthy providers (${healthy}/${total})`,
  };
}

function countHealthyProviders(providers: ProviderHealth[]): number {
  let healthy = 0;
  for (const provider of providers) {
    if (provider.ok) healthy += 1;
  }
  return healthy;
}

function computeHealthColorFromCounts(healthy: number, total: number): HealthColor {
  if (total === 0) return 'red';
  if (healthy === total) return 'green';
  if (healthy > 0) return 'yellow';
  return 'red';
}
