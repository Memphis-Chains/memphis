import { describe, expect, it } from 'vitest';

import { runCli, runCliResult } from '../helpers/cli.js';

describe('CLI chat', () => {
  it('returns JSON output for chat command', async () => {
    const out = await runCli(['chat', '--input', 'hello from cli', '--json'], {
      env: { DEFAULT_PROVIDER: 'local-fallback' },
    });

    const data = JSON.parse(out);
    expect(data.providerUsed).toBe('local-fallback');
    expect(data.output).toContain('hello from cli');
  });

  it('fails without --input', async () => {
    const result = await runCliResult(['chat', '--json'], {
      env: { DEFAULT_PROVIDER: 'local-fallback' },
    });

    expect(result.status).not.toBe(0);
  });
});
