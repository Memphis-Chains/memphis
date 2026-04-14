import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearPostApplyHooks,
  listPostApplyHooks,
  registerPostApplyHook,
  runPostApplyHooks,
} from '../../src/infra/config/post-apply-hooks.js';

/**
 * Regression net for Codex P1 against PR #94: the post-apply hook registry
 * was append-only, so any caller that constructed the same logical hook
 * twice (createAppContainer is invoked more than once in a process for
 * /ops/status, /providers, tests) accumulated stale duplicates against
 * retired service instances. The fix de-dupes by hookName.
 */

beforeEach(() => {
  clearPostApplyHooks();
});

afterEach(() => {
  clearPostApplyHooks();
});

describe('registerPostApplyHook — idempotency', () => {
  it('replaces the existing hook when re-registered with the same name', async () => {
    const calls: string[] = [];
    registerPostApplyHook('GEN_MAX_TOKENS', 'orchestration.setDefaultProvider', () => {
      calls.push('first-instance');
    });
    registerPostApplyHook('GEN_MAX_TOKENS', 'orchestration.setDefaultProvider', () => {
      calls.push('second-instance');
    });
    const hooks = listPostApplyHooks().find((h) => h.key === 'GEN_MAX_TOKENS');
    expect(hooks?.hookNames).toEqual(['orchestration.setDefaultProvider']);

    await runPostApplyHooks({
      changes: [{ key: 'GEN_MAX_TOKENS', oldValue: '1', newValue: '2' }],
    });
    expect(calls).toEqual(['second-instance']);
  });

  it('keeps distinct hookNames as separate entries', async () => {
    const fired: string[] = [];
    registerPostApplyHook('LOG_LEVEL', 'logger.refresh', () => fired.push('logger'));
    registerPostApplyHook('LOG_LEVEL', 'metrics.refresh', () => fired.push('metrics'));
    const hooks = listPostApplyHooks().find((h) => h.key === 'LOG_LEVEL');
    expect(hooks?.hookNames.sort()).toEqual(['logger.refresh', 'metrics.refresh']);

    await runPostApplyHooks({
      changes: [{ key: 'LOG_LEVEL', oldValue: 'info', newValue: 'debug' }],
    });
    expect(fired.sort()).toEqual(['logger', 'metrics']);
  });

  it('repeated re-registration does not grow the bucket (memory leak guard)', async () => {
    let lastInstance = 0;
    for (let i = 0; i < 100; i += 1) {
      registerPostApplyHook('DEFAULT_PROVIDER', 'orchestration.setDefaultProvider', () => {
        lastInstance = i;
      });
    }
    const hooks = listPostApplyHooks().find((h) => h.key === 'DEFAULT_PROVIDER');
    expect(hooks?.hookNames.length).toBe(1);

    await runPostApplyHooks({
      changes: [{ key: 'DEFAULT_PROVIDER', oldValue: 'a', newValue: 'b' }],
    });
    // Only the most recent registration fires.
    expect(lastInstance).toBe(99);
  });
});
