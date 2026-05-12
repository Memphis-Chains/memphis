/**
 * Anthropic prompt cache depends on byte-identity of the system prompt
 * across consecutive calls — even a single timestamp drift drops the
 * cache and the operator pays full prompt cost on every turn.
 *
 * P5 #18 from `docs/roadmap/2026-05-11-post-autonomy-todo-and-gap.md`
 * called for "a standing unit test that builds prompt 2x and asserts
 * byte-equality" — locking in the determinism contract so a future
 * refactor (Object.entries iteration order, a stray new Date(), a Set
 * without sort) can't quietly murder the cache.
 *
 * Test surface here:
 *   1. Identical context → byte-equal output.
 *   2. Different `now` → output differs (sanity: clock IS load-bearing).
 *   3. Identical context with explicit `now` → byte-equal across calls
 *      separated by an artificial wall-clock delay (proves we don't
 *      sneak in a `Date.now()` somewhere beyond the supplied anchor).
 */
import { describe, expect, it } from 'vitest';

import { buildSystemPrompt, type SystemPromptContext } from '../../src/gateway/system-prompt.js';

function fixedContext(overrides: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    now: new Date('2026-05-12T14:00:00.000Z'),
    agentName: 'Memphis Agent',
    ownerName: 'local operator',
    safeMode: false,
    strictMode: false,
    rustBridgeActive: true,
    availableTools: ['memphis_journal', 'memphis_recall', 'memphis_search'],
    chainStats: { journal: 509, decisions: 130 },
    userIdentity: 'did:key:test',
    ...overrides,
  };
}

describe('system-prompt cache stability', () => {
  it('produces byte-identical output for identical context (Anthropic cache hit)', () => {
    const ctx = fixedContext();
    const a = buildSystemPrompt(ctx);
    const b = buildSystemPrompt(ctx);
    expect(a).toBe(b);
  });

  it('produces different output when `now` shifts (anchor IS load-bearing)', () => {
    const a = buildSystemPrompt(fixedContext({ now: new Date('2026-05-12T14:00:00.000Z') }));
    const b = buildSystemPrompt(fixedContext({ now: new Date('2026-05-12T15:00:00.000Z') }));
    expect(a).not.toBe(b);
  });

  it('stays byte-identical across a real wall-clock delay when context is fixed', async () => {
    // The defensive case: a careless Date.now() sneak-in inside the
    // builder would only show up when actual time passes between calls.
    // 50 ms is short enough not to slow CI yet long enough to defeat
    // a single-tick clock read.
    const ctx = fixedContext();
    const first = buildSystemPrompt(ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = buildSystemPrompt(ctx);
    expect(second).toBe(first);
  });

  it('changes when chainStats key order is unchanged but counts differ', () => {
    // Sanity: real-world drift between turns (e.g. operator added one
    // journal block) MUST flip the prompt — otherwise the cache could
    // serve stale state. Catches the over-eager normalizer that might
    // strip counts.
    const a = buildSystemPrompt(fixedContext({ chainStats: { journal: 509, decisions: 130 } }));
    const b = buildSystemPrompt(fixedContext({ chainStats: { journal: 510, decisions: 130 } }));
    expect(a).not.toBe(b);
  });

  it('produces byte-identical output regardless of `availableTools` array reference', () => {
    // Two separate array literals with identical contents should yield
    // the same prompt. If someone ever serializes the array reference
    // identity (cursed but possible), this catches it.
    const toolsA = ['memphis_journal', 'memphis_recall'];
    const toolsB = ['memphis_journal', 'memphis_recall'];
    expect(toolsA).not.toBe(toolsB); // confirm fresh reference
    const a = buildSystemPrompt(fixedContext({ availableTools: toolsA }));
    const b = buildSystemPrompt(fixedContext({ availableTools: toolsB }));
    expect(a).toBe(b);
  });
});
