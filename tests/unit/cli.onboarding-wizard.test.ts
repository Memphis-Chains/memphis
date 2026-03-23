import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI onboarding wizard', () => {
  it('returns checklist progress json', async () => {
    const out = await runCli(['onboarding', 'wizard', '--json']);
    const parsed = JSON.parse(out) as {
      progress: string;
      checklist: Array<{ step: string }>;
      guide: { sections: Array<{ title: string }> };
    };

    expect(parsed.progress).toContain('/');
    expect(parsed.checklist.length).toBeGreaterThan(0);
    expect(parsed.checklist.some((item) => item.step === 'env-file')).toBe(true);
    expect(parsed.guide.sections.some((section) => section.title === 'Secrets')).toBe(true);
  });

  it('writes env/profile with explicit secret awareness json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-onboarding-write-'));
    const out = await runCli(
      [
        'onboarding',
        'wizard',
        '--write',
        '--profile',
        'dev-local',
        '--out',
        '.env',
        '--force',
        '--json',
      ],
      {
        cwd: dir,
        env: { MEMPHIS_DATA_DIR: join(dir, '.memphis') },
      },
    );
    const parsed = JSON.parse(out) as {
      write: {
        path: string;
        secretAwareness: { envPath: string; secrets: Array<{ key: string; value: string }> };
      };
    };

    expect(parsed.write.path).toContain('.env');
    expect(parsed.write.secretAwareness.envPath).toContain('.env');
    expect(parsed.write.secretAwareness.secrets.map((secret) => secret.key)).toEqual([
      'MEMPHIS_API_TOKEN',
      'MEMPHIS_VAULT_PEPPER',
    ]);
    expect(parsed.write.secretAwareness.secrets.every((secret) => secret.value.length > 10)).toBe(
      true,
    );
  });
});
