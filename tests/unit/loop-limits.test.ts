import { describe, expect, it } from 'vitest';

import { DEFAULT_LOOP_LIMITS } from '../../src/gateway/agent-runtime.js';
import { LOOP_LIMITS, formatLoopLimitsLine } from '../../src/gateway/loop-limits.js';
import { buildSystemPrompt } from '../../src/gateway/system-prompt.js';

describe('LOOP_LIMITS single source of truth', () => {
  it('exposes frozen canonical values', () => {
    expect(LOOP_LIMITS).toEqual({
      max_steps: 48,
      max_tool_calls: 64,
      max_wait_ms: 120_000,
      max_errors: 4,
    });
    expect(Object.isFrozen(LOOP_LIMITS)).toBe(true);
  });

  it('agent-runtime DEFAULT_LOOP_LIMITS mirrors LOOP_LIMITS', () => {
    expect(DEFAULT_LOOP_LIMITS).toEqual(LOOP_LIMITS);
  });

  it('formatLoopLimitsLine renders every field with the canonical value', () => {
    expect(formatLoopLimitsLine()).toBe(
      'max_steps=48, max_tool_calls=64, max_wait_ms=120000, max_errors=4',
    );
  });

  it('system prompt embeds the canonical values (not the old 16 stale default)', () => {
    const prompt = buildSystemPrompt({
      availableTools: ['memphis_loop_step'],
      rustBridgeActive: true,
    });
    expect(prompt).toContain('max_tool_calls=64');
    expect(prompt).not.toMatch(/max_tool_calls=16/);
    expect(prompt).toContain('max 48 steps');
    expect(prompt).toContain('64 tool calls');
    expect(prompt).toContain('max 4 errors allowed');
  });
});
