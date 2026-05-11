/**
 * Production safety — degraded-boot path tests.
 *
 * The legacy hard-throw behavior is regression-covered in
 * tests/unit/config-profiles.test.ts under the strict-mode flag.
 * This file exercises the new default (degraded-by-default) added
 * in `fix/config-degraded-boot-on-missing-vault` so the daemon
 * boots with collected `degradedReasons` instead of crashing the
 * systemd restart loop when a production secret is missing.
 *
 * Plumbing:
 *   validateProductionSafety(config) returns { degradedReasons }
 *   loadConfigDetailed() exposes that on the AppConfig consumer side
 *   /health.degradedConfig.reasons mirrors it for monitoring
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  validateProductionSafety,
  applyConfigProfile,
} from '../../src/infra/config/profiles.js';
import type { AppConfig } from '../../src/infra/config/schema.js';

function base(): AppConfig {
  // Mirror the shape used by tests/unit/config-profiles.test.ts.
  return {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    LOG_FORMAT: 'json',
    HOST: '127.0.0.1',
    PORT: 3000,
    DATABASE_URL: 'file:./test.db',
    DEFAULT_PROVIDER: 'local-fallback',
    GEN_TIMEOUT_MS: 20_000,
    GEN_MAX_TOKENS: 1024,
  } as unknown as AppConfig;
}

describe('validateProductionSafety — degraded-boot path (default)', () => {
  const cleanedEnv: string[] = [];

  beforeEach(() => {
    cleanedEnv.length = 0;
  });

  afterEach(() => {
    for (const key of cleanedEnv) delete process.env[key];
  });

  const setEnv = (key: string, value: string) => {
    process.env[key] = value;
    cleanedEnv.push(key);
  };

  it('collects MEMPHIS_API_TOKEN missing into degradedReasons (no throw)', () => {
    const cfg = base();
    delete process.env.MEMPHIS_API_TOKEN;
    const result = validateProductionSafety(cfg);
    expect(result.degradedReasons).toHaveLength(1);
    expect(result.degradedReasons[0]).toMatch(/MEMPHIS_API_TOKEN/);
  });

  it('multi-reason aggregation — token + provider gap', () => {
    // Both: MEMPHIS_API_TOKEN missing AND DEFAULT_PROVIDER=minimax with no credentials.
    const cfg = { ...base(), DEFAULT_PROVIDER: 'minimax' as const };
    delete process.env.MEMPHIS_API_TOKEN;
    const result = validateProductionSafety(cfg);
    expect(result.degradedReasons.length).toBe(2);
    expect(result.degradedReasons.some((r) => /MEMPHIS_API_TOKEN/.test(r))).toBe(true);
    expect(result.degradedReasons.some((r) => /minimax/i.test(r))).toBe(true);
  });

  it('Anthropic provider gap — captures the production-incident shape (R3)', () => {
    // The actual case Memphis runs into: DEFAULT_PROVIDER=anthropic with
    // none of (ANTHROPIC_API_KEY | ANTHROPIC_VAULT_KEY | ANTHROPIC_OAUTH_CLIENT_ID).
    // Before this PR + R3: daemon currently crashes on FIRST TURN when
    // adapter tries to use missing auth (no boot-time signal).
    // After: degradedReasons surfaced at boot via /health.
    setEnv('MEMPHIS_API_TOKEN', 'token-123');
    const cfg = { ...base(), DEFAULT_PROVIDER: 'anthropic' as const };
    const result = validateProductionSafety(cfg);
    expect(result.degradedReasons.length).toBe(1);
    expect(result.degradedReasons[0]).toMatch(/anthropic/i);
    expect(result.degradedReasons[0]).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('Anthropic provider satisfied by OAuth client id (vault-equivalent)', () => {
    // ANTHROPIC_OAUTH_CLIENT_ID is the operator-authorized browser-flow
    // path — counts as a valid credential. No degradation reason.
    setEnv('MEMPHIS_API_TOKEN', 'token-123');
    const cfg = {
      ...base(),
      DEFAULT_PROVIDER: 'anthropic' as const,
      ANTHROPIC_OAUTH_CLIENT_ID: 'client-abc',
    } as unknown as AppConfig;
    const result = validateProductionSafety(cfg);
    expect(result.degradedReasons).toHaveLength(0);
  });

  it('clean production boot — no degradedReasons', () => {
    setEnv('MEMPHIS_API_TOKEN', 'token-123');
    const cfg = base();
    const result = validateProductionSafety(cfg);
    expect(result.degradedReasons).toHaveLength(0);
  });

  it('non-production NODE_ENV skips production safety entirely', () => {
    const cfg = { ...base(), NODE_ENV: 'development' as const };
    delete process.env.MEMPHIS_API_TOKEN;
    const result = validateProductionSafety(cfg);
    expect(result.degradedReasons).toHaveLength(0);
  });

  it('MEMPHIS_STRICT_PRODUCTION_SAFETY=1 restores hard-throw on collected reasons', () => {
    // Opt-in escape hatch for CI / paranoid prod deployments.
    setEnv('MEMPHIS_STRICT_PRODUCTION_SAFETY', '1');
    const cfg = base();
    delete process.env.MEMPHIS_API_TOKEN;
    expect(() => validateProductionSafety(cfg)).toThrow(/strict mode/);
  });

  it('MEMPHIS_STRICT_PRODUCTION_SAFETY=1 with no reasons — does NOT throw', () => {
    // Strict mode is opt-in for the hard-fail, not a default-toxic mode.
    // Clean production boot with strict ON still returns gracefully.
    setEnv('MEMPHIS_STRICT_PRODUCTION_SAFETY', '1');
    setEnv('MEMPHIS_API_TOKEN', 'token-123');
    const cfg = base();
    const result = validateProductionSafety(cfg);
    expect(result.degradedReasons).toHaveLength(0);
  });

  it('applyConfigProfile is unaffected by safety probe — production caps still applied', () => {
    // applyConfigProfile + validateProductionSafety are independent.
    // Confirming the refactor didn't ripple into profile handling.
    const cfg = {
      ...base(),
      LOG_LEVEL: 'debug' as const,
      GEN_TIMEOUT_MS: 600_000,
      GEN_MAX_TOKENS: 128_000,
    };
    const out = applyConfigProfile(cfg);
    expect(out.LOG_LEVEL).toBe('info');
    expect(out.GEN_TIMEOUT_MS).toBe(20_000);
    expect(out.GEN_MAX_TOKENS).toBe(1024);
  });
});
