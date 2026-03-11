import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

describe('CLI health', () => {
  it('prints JSON for health command', () => {
    const out = execSync('DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts health --json', {
      encoding: 'utf8',
    });

    const data = JSON.parse(out);
    expect(data.status).toBe('ok');
    expect(data.service).toBe('memphis-v5');
  });
});
