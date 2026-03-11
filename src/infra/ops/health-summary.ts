import type { ProviderHealth } from '../../core/types.js';

export type HealthColor = 'green' | 'yellow' | 'red';

export function computeHealthColor(input: {
  providers: ProviderHealth[];
  uptimeSec: number;
}): HealthColor {
  const total = input.providers.length;
  const healthy = input.providers.filter((p) => p.ok).length;

  if (total === 0) return 'red';
  if (healthy === total) return 'green';
  if (healthy > 0) return 'yellow';
  return 'red';
}

export function computeHealthSummary(input: { providers: ProviderHealth[]; uptimeSec: number }) {
  const color = computeHealthColor(input);
  const healthy = input.providers.filter((p) => p.ok).length;
  const total = input.providers.length;

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
