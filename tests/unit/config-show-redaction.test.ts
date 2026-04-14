import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMemphisConfigShow } from '../../src/mcp/tools/config.js';

/**
 * Regression net for Codex P1 against PRs #84 (Telegram /config show, HTTP
 * /v1/ops/config/show) and #88 (MCP memphis_config_show). The bug: all
 * three call sites accepted any caller-supplied key, read process.env[key]
 * directly, and only redacted when classifyField(key) === 'secret'. Unknown
 * env vars (host-side credentials, legacy operator-only env, etc.) leaked
 * verbatim because the default tier for unknown keys is 'warm' (not secret).
 *
 * Fix: whitelist the request to listKnownFields() and reject anything else.
 * Tested here for the MCP variant; the HTTP and Telegram fixes mirror it
 * — see PR description for surface coverage notes.
 */

const SECRET_VAR = 'OPERATOR_LEGACY_TOKEN';
const SECRET_VALUE = 'sk-leak-this-please-no-thanks';

const savedEnv = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  // Set both a known and an unknown env to prove which gets returned.
  process.env.GEN_MAX_TOKENS = '4096';
  process.env[SECRET_VAR] = SECRET_VALUE;
});

afterEach(() => {
  delete process.env.GEN_MAX_TOKENS;
  delete process.env[SECRET_VAR];
});

describe('runMemphisConfigShow — whitelist enforcement (Codex P1)', () => {
  it('lists known fields when no key is supplied (and never includes unknown env vars)', () => {
    const result = runMemphisConfigShow();
    expect(result.values.GEN_MAX_TOKENS).toBe('4096');
    expect(result.values).not.toHaveProperty(SECRET_VAR);
    // Sanity: the value of the leak candidate is nowhere in the response
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it('returns a single known key when supplied', () => {
    const result = runMemphisConfigShow({ key: 'GEN_MAX_TOKENS' });
    expect(result.requestedKey).toBe('GEN_MAX_TOKENS');
    expect(result.values.GEN_MAX_TOKENS).toBe('4096');
  });

  it('refuses to echo an unknown env var even when the operator asks for it by name', () => {
    const result = runMemphisConfigShow({ key: SECRET_VAR });
    expect(result.requestedKey).toBe(SECRET_VAR);
    expect(result.unknownKey).toBe(SECRET_VAR);
    expect(result.values).toEqual({});
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it('refuses unknown keys with a typo-ish name (defense against probing)', () => {
    const result = runMemphisConfigShow({ key: 'GEN_MAX_TOKEN' /* missing trailing S */ });
    expect(result.unknownKey).toBe('GEN_MAX_TOKEN');
    expect(result.values).toEqual({});
  });

  it('still redacts known SECRET fields when listing all', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    try {
      const result = runMemphisConfigShow();
      expect(result.values.ANTHROPIC_API_KEY).toBe('***redacted***');
      expect(JSON.stringify(result)).not.toContain('sk-ant-secret');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('still redacts a known SECRET field when requested by name', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    try {
      const result = runMemphisConfigShow({ key: 'ANTHROPIC_API_KEY' });
      expect(result.values.ANTHROPIC_API_KEY).toBe('***redacted***');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
