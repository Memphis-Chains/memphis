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
    expect(built.env.RUST_EMBED_PERSIST_ENABLED).toBe('true');
    expect(built.env.RUST_EMBED_PERSIST_PATH).toBe('./data/embed-index.json');
    expect(built.env.MCP_PORT).toBe('3001');
    expect(built.env.MEMPHIS_AGENT_NAME).toBe('Memphis Agent');
    expect(built.env.MEMPHIS_OWNER_NAME).toBe('local operator');
    expect(typeof built.env.MEMPHIS_API_TOKEN).toBe('string');
    expect(built.env.MEMPHIS_API_TOKEN.length).toBeGreaterThan(10);
    expect(built.env.DATABASE_URL).toBe('file:./data/memphis.db');
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

  it('emits canonical deepseek config keys and explicit MCP port', () => {
    const built = buildSetupEnv({
      envPath: '.env',
      provider: 'deepseek',
      providerBaseUrl: 'https://api.deepseek.com',
      dataDirectory: './data',
      embeddingMode: 'openai-compatible',
      embeddingEndpoint: 'https://api.deepseek.com/embeddings',
      embeddingModel: 'text-embedding-3-small',
      vaultPepper: 'memphis-super-secure-pepper',
    });

    expect(built.validation.ok).toBe(true);
    expect(built.env.MCP_PORT).toBe('3001');
    expect(built.env.DEEPSEEK_API_BASE).toBe('https://api.deepseek.com');
    expect(built.env.DEEPSEEK_VAULT_KEY).toBe('deepseek_api_key');
    expect(built.content).toContain('MCP_PORT=3001');
    expect(built.content).toContain('DEEPSEEK_API_BASE=https://api.deepseek.com');
  });
});

describe('setup CLI', () => {
  it('supports init as alias for setup', async () => {
    const runner = vi.fn().mockResolvedValue({
      ok: true,
      action: 'initialized',
      mode: 'minimal-baseline',
      status: {
        state: 'initialized-clean',
        initialized: true,
        envPresent: true,
        vaultInitialized: true,
        operatorConfigured: true,
        legacyChains: [],
        legacyFiles: 0,
        reasons: [],
        recommendedAction: 'none',
        record: {
          schemaVersion: 1,
          initializedAt: new Date().toISOString(),
          mode: 'minimal-baseline',
          createdChains: ['journal', 'system'],
          createdBlocks: 2,
          summary: 'test init',
          origin: 'controlled-init',
        },
      },
      health: {
        status: 'healthy',
        repairStatus: 'healthy',
        recommendedAction: 'none',
      },
      createdChains: ['journal', 'system'],
      createdBlocks: 2,
      summary: 'test init',
      warnings: [],
      nextSteps: [],
    });

    for (const alias of ['init'] as const) {
      const context = {
        args: {
          command: alias,
          subcommand: undefined,
          json: true,
          state: 'minimal-baseline',
          force: true,
        },
      } as CliContext;

      const handled = await handleSetupCommand(context, runner);
      expect(handled).toBe(true);
    }

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          command: 'init',
          state: 'minimal-baseline',
          force: true,
        }),
      }),
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
