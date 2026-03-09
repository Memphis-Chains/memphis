import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

describe('CLI tui output', () => {
  it('prints framed output for --tui', () => {
    const out = execSync(
      'DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts ask --input "hello" --tui',
      { encoding: 'utf8' },
    );

    expect(out).toContain('memphis ask');
    expect(out).toContain('╔');
    expect(out).toContain('╚');
  });
});
