import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

describe('CLI ask + doctor', () => {
  it('supports ask alias with JSON output', () => {
    const out = execSync(
      'DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts ask --input "hello ask" --json',
      { encoding: 'utf8' },
    );

    const data = JSON.parse(out);
    expect(data.providerUsed).toBe('local-fallback');
    expect(data.output).toContain('hello ask');
  });

  it('doctor reports onboarding checks', () => {
    const out = execSync('npx tsx src/infra/cli/index.ts doctor --json', {
      encoding: 'utf8',
    });

    const data = JSON.parse(out);
    expect(data.ok).toBe(true);
    expect(data.checks).toHaveProperty('embedApiAvailable');
    expect(data.checks).toHaveProperty('vaultPepperConfigured');
  });
});
