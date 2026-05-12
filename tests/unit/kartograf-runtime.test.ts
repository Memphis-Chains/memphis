/**
 * Tests for the Kartograf runtime singleton.
 *
 * These cover the disabled / no-checkpoint paths (which run on every
 * machine — no ONNX runtime needed) plus the cache-once contract.
 * The "real ONNX session loads and serves embeddings" path is exercised
 * by the live smoke run + `memphis kartograf query`; reproducing it
 * here would require shipping the 737 MB checkpoint in CI, which the
 * spec explicitly rules out.
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { _resetKartografRuntimeForTests, getKartografRuntime } from '../../src/kartograf/runtime.js';

describe('kartograf runtime', () => {
  beforeEach(() => {
    _resetKartografRuntimeForTests();
  });

  it('returns disabled when MEMPHIS_KARTOGRAF_ENABLE is unset', async () => {
    const status = await getKartografRuntime({
      MEMPHIS_HOME: '/tmp/kartograf-rt-test-1',
    } as NodeJS.ProcessEnv);
    expect(status.kind).toBe('disabled');
    if (status.kind === 'disabled') {
      expect(status.reason).toMatch(/MEMPHIS_KARTOGRAF_ENABLE/);
    }
  });

  it('returns no-checkpoint when flag set but stage dir is empty', async () => {
    const status = await getKartografRuntime({
      MEMPHIS_KARTOGRAF_ENABLE: '1',
      MEMPHIS_HOME: '/tmp/kartograf-rt-test-2-no-such-dir-xyz123',
      MEMPHIS_DATA_DIR: '/tmp/kartograf-rt-test-2-no-such-dir-xyz123/data',
    } as NodeJS.ProcessEnv);
    expect(status.kind).toBe('no-checkpoint');
  });

  it('caches the disabled status across subsequent calls', async () => {
    const env = { MEMPHIS_HOME: '/tmp/kartograf-rt-test-3' } as NodeJS.ProcessEnv;
    const a = await getKartografRuntime(env);
    const b = await getKartografRuntime(env);
    expect(a).toBe(b); // same object reference — pulled from cache
  });

  it('reset clears the cache', async () => {
    const env = { MEMPHIS_HOME: '/tmp/kartograf-rt-test-4' } as NodeJS.ProcessEnv;
    const a = await getKartografRuntime(env);
    _resetKartografRuntimeForTests();
    const b = await getKartografRuntime(env);
    expect(a).not.toBe(b); // different objects after reset
    expect(a.kind).toBe(b.kind); // but same status
  });
});
