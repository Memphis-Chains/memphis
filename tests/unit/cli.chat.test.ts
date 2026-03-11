import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

describe('CLI chat', () => {
  it('returns JSON output for chat command', () => {
    const out = execSync(
      'DEFAULT_PROVIDER=local-fallback tsx src/infra/cli/index.ts chat --input "hello from cli" --json',
      { encoding: 'utf8' },
    );

    const data = JSON.parse(out);
    expect(data.providerUsed).toBe('local-fallback');
    expect(data.output).toContain('hello from cli');
  });

  it('fails without --input', () => {
    let failed = false;
    try {
      execSync('DEFAULT_PROVIDER=local-fallback tsx src/infra/cli/index.ts chat --json', {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
  });
});
