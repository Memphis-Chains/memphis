import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearPostApplyHooks,
  listPostApplyHooks,
  registerPostApplyHook,
  runPostApplyHooks,
  unregisterPostApplyHooks,
} from '../../src/infra/config/post-apply-hooks.js';

beforeEach(() => {
  clearPostApplyHooks();
});

afterEach(() => {
  clearPostApplyHooks();
});

describe('post-apply hook registry', () => {
  it('starts empty', () => {
    expect(listPostApplyHooks()).toEqual([]);
  });

  it('runs hooks for changed keys with full context', async () => {
    const calls: Array<{
      key: string;
      previousValue: string | undefined;
      nextValue: string | undefined;
    }> = [];
    registerPostApplyHook('GEN_MAX_TOKENS', 'test.capture', (ctx) => {
      calls.push({
        key: ctx.key,
        previousValue: ctx.previousValue,
        nextValue: ctx.nextValue,
      });
    });
    const outcomes = await runPostApplyHooks({
      changes: [{ key: 'GEN_MAX_TOKENS', oldValue: '1024', newValue: '4096' }],
    });
    expect(outcomes).toEqual([{ key: 'GEN_MAX_TOKENS', hookName: 'test.capture', ok: true }]);
    expect(calls).toEqual([{ key: 'GEN_MAX_TOKENS', previousValue: '1024', nextValue: '4096' }]);
  });

  it('skips keys with no registered hook', async () => {
    const outcomes = await runPostApplyHooks({
      changes: [{ key: 'UNREGISTERED_KEY', oldValue: 'a', newValue: 'b' }],
    });
    expect(outcomes).toEqual([]);
  });

  it('captures hook errors without aborting later hooks', async () => {
    const fired: string[] = [];
    registerPostApplyHook('LOG_LEVEL', 'first.fails', () => {
      fired.push('first');
      throw new Error('boom');
    });
    registerPostApplyHook('LOG_LEVEL', 'second.runs', () => {
      fired.push('second');
    });
    const outcomes = await runPostApplyHooks({
      changes: [{ key: 'LOG_LEVEL', oldValue: 'info', newValue: 'debug' }],
    });
    expect(fired).toEqual(['first', 'second']);
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.error).toBe('boom');
    expect(outcomes[1]?.ok).toBe(true);
  });

  it('supports async hooks', async () => {
    let captured: string | undefined;
    registerPostApplyHook('OLLAMA_URL', 'async.capture', async (ctx) => {
      await Promise.resolve();
      captured = ctx.nextValue;
    });
    await runPostApplyHooks({
      changes: [{ key: 'OLLAMA_URL', oldValue: 'a', newValue: 'http://ollama.local' }],
    });
    expect(captured).toBe('http://ollama.local');
  });

  it('listPostApplyHooks reports registered hook names by key', () => {
    registerPostApplyHook('A', 'a1', () => {});
    registerPostApplyHook('A', 'a2', () => {});
    registerPostApplyHook('B', 'b1', () => {});
    const listed = listPostApplyHooks().sort((a, b) => a.key.localeCompare(b.key));
    expect(listed).toEqual([
      { key: 'A', hookNames: ['a1', 'a2'] },
      { key: 'B', hookNames: ['b1'] },
    ]);
  });

  it('unregisterPostApplyHooks drops hooks for one key only', async () => {
    const fired: string[] = [];
    registerPostApplyHook('A', 'a-hook', () => fired.push('a'));
    registerPostApplyHook('B', 'b-hook', () => fired.push('b'));
    unregisterPostApplyHooks('A');
    await runPostApplyHooks({
      changes: [
        { key: 'A', oldValue: '1', newValue: '2' },
        { key: 'B', oldValue: '3', newValue: '4' },
      ],
    });
    expect(fired).toEqual(['b']);
  });
});
