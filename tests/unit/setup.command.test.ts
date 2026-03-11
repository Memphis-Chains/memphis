import { describe, expect, it, vi } from 'vitest';

import { buildSetupEnv, handleSetupCommand } from '../../src/infra/cli/commands/setup.js';
import type { CliContext } from '../../src/infra/cli/context.js';

describe('setup env builder', () => {
  it('builds a valid local-only setup with defaults', () => {
    const built = buildSetupEnv({
      envPath: '.env',
      provider: 'local',
      dataDirectory: './data',
      embeddingMode: 'local',
      embeddingModel: '',
      vaultPepper: 'memphis-super-secure-pepper',
    });

    expect(built.validation.ok).toBe(true);
    expect(built.env.DEFAULT_PROVIDER).toBe('local-fallback');
    expect(built.env.RUST_EMBED_MODE).toBe('local');
    expect(built.env.DATABASE_URL).toBe('file:./data/memphis-v5.db');
  });

  it('flags missing API key for remote providers after generation', () => {
    const built = buildSetupEnv({
      envPath: '.env',
      provider: 'openai',
      providerBaseUrl: 'https://api.openai.com/v1',
      providerApiKey: '',
      dataDirectory: './data',
      embeddingMode: 'openai-compatible',
      embeddingEndpoint: 'https://api.openai.com/v1/embeddings',
      embeddingModel: 'text-embedding-3-small',
      vaultPepper: 'memphis-super-secure-pepper',
    });

    expect(built.validation.ok).toBe(false);
    expect(built.validation.errors.join('\n')).toMatch(/Provider API key was skipped/);
    expect(built.validation.warnings.join('\n')).toMatch(/Remote generation is not ready/);
  });
});

describe('setup CLI', () => {
  it('supports init as alias for setup', async () => {
    const runner = vi.fn().mockResolvedValue({
      ok: true,
      envPath: '/tmp/test.env',
      provider: 'local',
      generated: { DEFAULT_PROVIDER: 'local-fallback' },
      validation: { ok: true, errors: [], warnings: [] },
      defaultsUsed: [],
      nextSteps: [],
    });

    for (const alias of ['init'] as const) {
      const context = {
        args: {
          command: alias,
          subcommand: undefined,
          json: true,
          out: '/tmp/test.env',
          force: true,
        },
      } as CliContext;

      const handled = await handleSetupCommand(context, runner);
      expect(handled).toBe(true);
    }

    expect(runner).toHaveBeenCalledWith({ outPath: '/tmp/test.env', force: true });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
