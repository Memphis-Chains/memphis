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
  it('walks past anthropic to local-fallback when OLLAMA_URL is unset', () => {
    // Codex P1 (Round 2): ollama can't be verified synchronously at config
    // load, so it is only picked when OLLAMA_URL is explicitly set. With no
    // OLLAMA_URL and no other creds, local-fallback is the safe terminator.
    const config = loadConfig(envWith({ DEFAULT_PROVIDER: 'anthropic' }));
    expect(config.DEFAULT_PROVIDER).toBe('local-fallback');
  });

  it('picks ollama from the cascade when OLLAMA_URL is set (operator opted in)', () => {
    const config = loadConfig(
      envWith({
        DEFAULT_PROVIDER: 'anthropic',
        OLLAMA_URL: 'http://127.0.0.1:11434',
      }),
    );
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

  it('walks past minimax to local-fallback when minimax also unconfigured and OLLAMA_URL unset', () => {
    const config = loadConfig(envWith({ DEFAULT_PROVIDER: 'anthropic' }));
    // Default cascade: ollama → anthropic → minimax → local-fallback.
    // Without minimax creds and without OLLAMA_URL (operator hasn't opted
    // into ollama), cascade lands on local-fallback.
    expect(config.DEFAULT_PROVIDER).toBe('local-fallback');
  });

  it('accepts Anthropic OAuth when BOTH client id and secret (vault) are set', () => {
    // Codex P2 (Round 2): Anthropic can be configured via OAuth. The
    // cascade picker must recognize it and not skip to a later tier.
    const config = loadConfig(
      envWith({
        DEFAULT_PROVIDER: 'shared-llm',
        ANTHROPIC_OAUTH_CLIENT_ID: 'oauth-client-id',
        ANTHROPIC_OAUTH_SECRET_VAULT_KEY: 'vault:oauth-secret',
      }),
    );
    expect(config.DEFAULT_PROVIDER).toBe('anthropic');
  });

  it('accepts Anthropic OAuth when BOTH client id and CLIENT_SECRET env are set', () => {
    const config = loadConfig(
      envWith({
        DEFAULT_PROVIDER: 'shared-llm',
        ANTHROPIC_OAUTH_CLIENT_ID: 'oauth-client-id',
        ANTHROPIC_OAUTH_CLIENT_SECRET: 'plaintext-oauth-secret',
      }),
    );
    expect(config.DEFAULT_PROVIDER).toBe('anthropic');
  });

  it('REJECTS Anthropic when only OAuth CLIENT_ID is set (no secret)', () => {
    // Codex P2 (Round 3): one OAuth field is NOT enough — runtime-registry
    // requires the full pair (client id + secret). Before this fix the
    // cascade picker treated any single OAuth field as "configured", so
    // loadConfig could select anthropic when no Anthropic client could
    // actually register at runtime.
    const config = loadConfig(
      envWith({
        DEFAULT_PROVIDER: 'shared-llm',
        ANTHROPIC_OAUTH_CLIENT_ID: 'oauth-client-id',
        // no ANTHROPIC_OAUTH_CLIENT_SECRET and no ANTHROPIC_OAUTH_SECRET_VAULT_KEY
      }),
    );
    expect(config.DEFAULT_PROVIDER).toBe('local-fallback');
  });

  it('REJECTS Anthropic when only OAuth SECRET_VAULT_KEY is set (no client id)', () => {
    const config = loadConfig(
      envWith({
        DEFAULT_PROVIDER: 'shared-llm',
        ANTHROPIC_OAUTH_SECRET_VAULT_KEY: 'vault:oauth-secret',
        // no ANTHROPIC_OAUTH_CLIENT_ID
      }),
    );
    expect(config.DEFAULT_PROVIDER).toBe('local-fallback');
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
