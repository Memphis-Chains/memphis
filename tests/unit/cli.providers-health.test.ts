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
    expect(data.providers[0].name).toBe('local-fallback');
  });
});
