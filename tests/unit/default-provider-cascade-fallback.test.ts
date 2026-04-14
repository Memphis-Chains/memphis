import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/infra/config/env.js';

/**
 * Regression net for Codex P1 against PR #80: when DEFAULT_PROVIDER's
 * required keys were missing, loadConfig collapsed straight to
 * 'local-fallback'. That short-circuited the operator-preferred cascade —
 * a fresh setup with `DEFAULT_PROVIDER=anthropic` and `MINIMAX_API_KEY`
 * set landed on local-fallback instead of trying minimax → ollama. The
 * fix walks the cascade in order and picks the first configured provider.
 */

const baseEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3000',
};

const savedEnv = { ...process.env };

beforeEach(() => {
  // Capture warnings so they don't pollute test output.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function envWith(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

describe('loadConfig — DEFAULT_PROVIDER cascade fallback', () => {
  it('walks past anthropic to ollama (no creds required) when nothing else configured', () => {
    // Ollama is in the default cascade and doesn't require credentials,
    // so it always wins before local-fallback. local-fallback is the
    // terminator only when ollama is somehow excluded.
    const config = loadConfig(envWith({ DEFAULT_PROVIDER: 'anthropic' }));
    expect(config.DEFAULT_PROVIDER).toBe('ollama');
  });

  it('walks the cascade to minimax when only minimax is configured', () => {
    const config = loadConfig(
      envWith({
        DEFAULT_PROVIDER: 'anthropic',
        MINIMAX_API_KEY: 'sk-mini-secret',
      }),
    );
    expect(config.DEFAULT_PROVIDER).toBe('minimax');
  });

  it('walks past minimax to ollama when minimax also unconfigured', () => {
    const config = loadConfig(envWith({ DEFAULT_PROVIDER: 'anthropic' }));
    // Default cascade: anthropic → minimax → ollama → local-fallback.
    // Without minimax, ollama is always-available (no creds required) —
    // so cascade lands there before local-fallback.
    // (When ollama is unreachable, the orchestration cascade catches that
    // at runtime; this test pins config-time behavior only.)
    expect(['ollama', 'local-fallback']).toContain(config.DEFAULT_PROVIDER);
  });

  it('honors MEMPHIS_PROVIDER_CASCADE override when picking fallback', () => {
    const config = loadConfig(
      envWith({
        DEFAULT_PROVIDER: 'anthropic',
        // Operator-preferred cascade: deepseek first, then minimax, then ollama
        MEMPHIS_PROVIDER_CASCADE: 'deepseek,minimax,ollama,local-fallback',
        DEEPSEEK_API_KEY: 'sk-deepseek-secret',
      }),
    );
    expect(config.DEFAULT_PROVIDER).toBe('deepseek');
  });

  it('keeps DEFAULT_PROVIDER when its keys ARE configured', () => {
    const config = loadConfig(
      envWith({
        DEFAULT_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
      }),
    );
    expect(config.DEFAULT_PROVIDER).toBe('anthropic');
  });
});
