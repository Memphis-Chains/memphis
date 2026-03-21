import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI guide', () => {
  it('prints operator guide json', async () => {
    const out = await runCli(['guide', '--json'], {
      env: {
        MEMPHIS_AGENT_NAME: 'Jawor',
        MEMPHIS_OWNER_NAME: 'Marcin',
        MEMPHIS_API_TOKEN: 'token',
        MEMPHIS_VAULT_PEPPER: 'memphis-super-secure-pepper',
      },
    });

    const parsed = JSON.parse(out) as {
      agentName: string;
      ownerName: string;
      sections: Array<{ title: string; lines: string[] }>;
    };

    expect(parsed.agentName).toBe('Jawor');
    expect(parsed.ownerName).toBe('Marcin');
    expect(parsed.sections.some((section) => section.title === 'Tools')).toBe(true);
  });
});
