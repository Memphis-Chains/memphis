import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

describe('CLI providers:health', () => {
  it('prints providers health in JSON', () => {
    const out = execSync('DEFAULT_PROVIDER=local-fallback tsx src/infra/cli/index.ts providers:health --json', {
      encoding: 'utf8',
    });

    const data = JSON.parse(out);
    expect(data.defaultProvider).toBe('local-fallback');
    expect(Array.isArray(data.providers)).toBe(true);
    expect(data.providers[0].name).toBe('local-fallback');
  });
});
