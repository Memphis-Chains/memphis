import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI onboarding wizard', () => {
  it('returns checklist progress json', async () => {
    const out = await runCli(['onboarding', 'wizard', '--json']);
    const parsed = JSON.parse(out) as {
      progress: string;
      checklist: Array<{ step: string }>;
    };

    expect(parsed.progress).toContain('/');
    expect(parsed.checklist.length).toBeGreaterThan(0);
    expect(parsed.checklist.some((item) => item.step === 'env-file')).toBe(true);
  });
});
