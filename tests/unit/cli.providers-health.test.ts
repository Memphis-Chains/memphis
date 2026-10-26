import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI providers:health', () => {
  it('prints providers health in JSON', async () => {
    const out = await runCli(['providers:health', '--json'], {
      env: { DEFAULT_PROVIDER: 'local-fallback' },
    });

    const data = JSON.parse(out);
    expect(data.defaultProvider).toBe('local-fallback');
    expect(Array.isArray(data.providers)).toBe(true);
    // Which providers are registered depends on the environment, so assert
    // membership rather than position: the registry order is an
    // implementation detail, the presence of the local fallback is not.
    expect(data.providers.map((provider: { name: string }) => provider.name)).toContain(
      'local-fallback',
    );
  });
});
