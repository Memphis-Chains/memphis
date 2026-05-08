import { describe, expect, it } from 'vitest';

import { DEFAULT_LOOP_LIMITS } from '../../src/gateway/agent-runtime.js';
import { LOOP_LIMITS, formatLoopLimitsLine } from '../../src/gateway/loop-limits.js';
import { buildSystemPrompt } from '../../src/gateway/system-prompt.js';

describe('LOOP_LIMITS single source of truth', () => {
  it('exposes frozen canonical values', () => {
    // Phase 1.5.1 (autopilot 2026-05-08): values bumped per
    // LIMITS-MATRIX-2026-05-08 + Rust↔TS parity test. The drift-protection
    // test in tests/unit/loop-limits-parity.test.ts cross-checks against
    // crates/memphis-core/src/loop_engine.rs and chat.rs.
    expect(LOOP_LIMITS).toEqual({
      max_steps: 1_000,
      max_tool_calls: 1_024,
      max_wait_ms: 120_000,
      max_errors: 32,
    });
    expect(Object.isFrozen(LOOP_LIMITS)).toBe(true);
  });

  it('agent-runtime DEFAULT_LOOP_LIMITS mirrors LOOP_LIMITS', () => {
    expect(DEFAULT_LOOP_LIMITS).toEqual(LOOP_LIMITS);
  });

  it('formatLoopLimitsLine renders every field with the canonical value', () => {
    expect(formatLoopLimitsLine()).toBe(
      `max_steps=${LOOP_LIMITS.max_steps}, max_tool_calls=${LOOP_LIMITS.max_tool_calls}, max_wait_ms=${LOOP_LIMITS.max_wait_ms}, max_errors=${LOOP_LIMITS.max_errors}`,
    );
  });

  it('system prompt embeds the canonical values (not the old stale defaults)', () => {
    const prompt = buildSystemPrompt({
      availableTools: ['memphis_loop_step'],
      rustBridgeActive: true,
    });
    expect(prompt).toContain(`max_tool_calls=${LOOP_LIMITS.max_tool_calls}`);
    expect(prompt).not.toMatch(/max_tool_calls=16/);
    expect(prompt).not.toMatch(/max_tool_calls=64/);
    expect(prompt).toContain(`max ${LOOP_LIMITS.max_steps} steps`);
    expect(prompt).toContain(`${LOOP_LIMITS.max_tool_calls} tool calls`);
    expect(prompt).toContain(`max ${LOOP_LIMITS.max_errors} errors allowed`);
  });
});
