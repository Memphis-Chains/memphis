/**
 * Verify that env-configurable thresholds have correct defaults
 * and that env overrides are picked up.
 */

import { describe, expect, it } from 'vitest';

import { resolveChannelGatewayToken } from '../../src/app/bootstrap.js';

describe('configurable thresholds defaults', () => {
  it('loadConfig returns undefined for optional thresholds when not set', async () => {
    const { envSchema } = await import('../../src/infra/config/schema.js');
    const result = envSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Optional thresholds should be undefined when not set
    expect(result.data.MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES).toBeUndefined();
    expect(result.data.MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS).toBeUndefined();
    expect(result.data.MEMPHIS_SNAPSHOT_MAX_AGE_MS).toBeUndefined();
    expect(result.data.MEMPHIS_SNAPSHOT_MIN_KEEP).toBeUndefined();
    expect(result.data.MEMPHIS_HEARTBEAT_INTERVAL_MS).toBeUndefined();
    expect(result.data.MEMPHIS_REFLECTION_INTERVAL_MS).toBeUndefined();
    // Rate limits have maxed defaults so new installs ship with sane caps.
    expect(result.data.MEMPHIS_RATE_LIMIT_GLOBAL_MAX).toBe(600);
    expect(result.data.MEMPHIS_RATE_LIMIT_SENSITIVE_MAX).toBe(60);

    // Bool defaults
    expect(result.data.MEMPHIS_REFLECTION_ENABLED).toBe(true);
  });

  it('accepts env overrides for all threshold fields', async () => {
    const { envSchema } = await import('../../src/infra/config/schema.js');
    const result = envSchema.safeParse({
      MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: '10485760',
      MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: '5',
      MEMPHIS_SNAPSHOT_MAX_AGE_MS: '86400000',
      MEMPHIS_SNAPSHOT_MIN_KEEP: '1',
      MEMPHIS_HEARTBEAT_INTERVAL_MS: '30000',
      MEMPHIS_REFLECTION_ENABLED: 'false',
      MEMPHIS_REFLECTION_INTERVAL_MS: '43200000',
      MEMPHIS_RATE_LIMIT_GLOBAL_MAX: '50',
      MEMPHIS_RATE_LIMIT_SENSITIVE_MAX: '5',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES).toBe(10485760);
    expect(result.data.MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS).toBe(5);
    expect(result.data.MEMPHIS_SNAPSHOT_MAX_AGE_MS).toBe(86400000);
    expect(result.data.MEMPHIS_SNAPSHOT_MIN_KEEP).toBe(1);
    expect(result.data.MEMPHIS_HEARTBEAT_INTERVAL_MS).toBe(30000);
    expect(result.data.MEMPHIS_REFLECTION_ENABLED).toBe(false);
    expect(result.data.MEMPHIS_REFLECTION_INTERVAL_MS).toBe(43200000);
    expect(result.data.MEMPHIS_RATE_LIMIT_GLOBAL_MAX).toBe(50);
    expect(result.data.MEMPHIS_RATE_LIMIT_SENSITIVE_MAX).toBe(5);
  });

  it('rejects out-of-range threshold values', async () => {
    const { envSchema } = await import('../../src/infra/config/schema.js');

    // Chain rotation below 1MB
    const r1 = envSchema.safeParse({ MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: '100' });
    expect(r1.success).toBe(false);

    // Heartbeat below 5s
    const r2 = envSchema.safeParse({ MEMPHIS_HEARTBEAT_INTERVAL_MS: '1000' });
    expect(r2.success).toBe(false);

    // Reflection below 1h
    const r3 = envSchema.safeParse({ MEMPHIS_REFLECTION_INTERVAL_MS: '1000' });
    expect(r3.success).toBe(false);
  });
});

describe('telegram token override', () => {
  it('MEMPHIS_TELEGRAM_TOKEN_OVERRIDE takes precedence', () => {
    const token = resolveChannelGatewayToken({
      MEMPHIS_TELEGRAM_TOKEN_OVERRIDE: 'emergency-token',
      MEMPHIS_TELEGRAM_BOT_TOKEN: 'normal-token',
    });
    expect(token).toBe('emergency-token');
  });

  it('falls through to normal token when override is absent', () => {
    const token = resolveChannelGatewayToken({
      MEMPHIS_TELEGRAM_BOT_TOKEN: 'normal-token',
    });
    expect(token).toBe('normal-token');
  });

  it('falls through when override is empty string', () => {
    const token = resolveChannelGatewayToken({
      MEMPHIS_TELEGRAM_TOKEN_OVERRIDE: '  ',
      MEMPHIS_TELEGRAM_BOT_TOKEN: 'normal-token',
    });
    expect(token).toBe('normal-token');
  });

  it('returns null when no tokens are set', () => {
    const token = resolveChannelGatewayToken({});
    expect(token).toBeNull();
  });

  it('accepts TELEGRAM_BOT_TOKEN as fallback', () => {
    const token = resolveChannelGatewayToken({
      TELEGRAM_BOT_TOKEN: 'legacy-token',
    });
    expect(token).toBe('legacy-token');
  });
});

describe('rate limiter env configuration', () => {
  it('creates limiters with default values when env not set', async () => {
    const mod = await import('../../src/infra/http/rate-limit.js');
    // The module-level singletons should exist and be functional
    expect(mod.globalLimiter).toBeDefined();
    expect(mod.sensitiveLimiter).toBeDefined();
    expect(mod.execLimiter).toBeDefined();
  });

  it('rate limiter check does not throw under limit', async () => {
    const { RateLimiter } = await import('../../src/infra/http/rate-limit.js');
    const limiter = new RateLimiter(5, 60_000);
    // 5 calls should be fine
    for (let i = 0; i < 5; i++) {
      expect(() => limiter.check('test-key')).not.toThrow();
    }
  });

  it('rate limiter throws on exceeding limit', async () => {
    const { RateLimiter } = await import('../../src/infra/http/rate-limit.js');
    const limiter = new RateLimiter(2, 60_000);
    limiter.check('test-key');
    limiter.check('test-key');
    expect(() => limiter.check('test-key')).toThrow('Rate limit exceeded');
  });
});
