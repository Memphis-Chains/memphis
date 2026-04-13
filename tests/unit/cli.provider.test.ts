import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI provider', () => {
  it('lists supported helper-managed providers in JSON', async () => {
    const out = await runCli(['provider', 'list', '--json']);
    const data = JSON.parse(out) as {
      supported: string[];
      usage: string;
      examples: string[];
    };

    expect(data.supported).toEqual([
      'anthropic',
      'minimax',
      'deepseek',
      'glm',
      'shared-llm',
      'decentralized-llm',
    ]);
    expect(data.usage).toContain('memphis provider add <provider> --api-key <key>');
    expect(data.examples).toContain('memphis provider add minimax --api-key <key>');
  });
});
