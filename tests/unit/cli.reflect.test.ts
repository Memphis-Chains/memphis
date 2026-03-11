import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI reflect', () => {
  it('runs daily reflection and returns 6 reflections', async () => {
    const out = await runCli(['reflect', '--json'], {
      env: { DEFAULT_PROVIDER: 'local-fallback' },
    });

    const data = JSON.parse(out);
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('reflect');
    expect(data.count).toBe(6);
    expect(Array.isArray(data.reflections)).toBe(true);
  });
});
