import { describe, expect, it } from 'vitest';
import { runCli } from '../helpers/cli.js';

describe('CLI tui output', () => {
  it('prints framed output for --tui', async () => {
    const out = await runCli(['ask', '--input', 'hello', '--tui'], {
      env: { DEFAULT_PROVIDER: 'local-fallback' },
    });

    expect(out).toContain('memphis ask');
    expect(out).toContain('╔');
    expect(out).toContain('╚');
  });
});
