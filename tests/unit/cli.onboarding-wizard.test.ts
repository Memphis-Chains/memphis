import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

describe('CLI onboarding wizard', () => {
  it('returns checklist progress json', () => {
    const out = execSync('npx tsx src/infra/cli/index.ts onboarding wizard --json', { encoding: 'utf8' });
    const parsed = JSON.parse(out) as { progress: string; checklist: Array<{ step: string }> };
    expect(parsed.progress).toContain('/');
    expect(parsed.checklist.length).toBeGreaterThan(0);
    expect(parsed.checklist.some((s) => s.step === 'env-file')).toBe(true);
  });
});
