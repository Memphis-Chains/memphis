import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOOP_LIMITS } from '../../src/gateway/loop-limits.js';

/**
 * Phase 1.5 P4 follow-up (autopilot 2026-05-08):
 *
 * The audit in docs/dev/LIMITS-MATRIX-2026-05-08.md found three surfaces
 * defining loop limits independently:
 *   1. src/gateway/loop-limits.ts (LOOP_LIMITS) — TS host source
 *   2. crates/memphis-core/src/loop_engine.rs (LoopLimits::default) — Rust core
 *   3. crates/memphis-operator/src/chat.rs (CHAT_MAX_*_DEFAULT) — Rust operator
 *
 * Previously they drifted: TS said max_tool_calls=64 while Rust enforced 16.
 * The Rust side enforces at runtime, so the TS value was misleading. Same
 * for max_errors (TS=4 vs Rust=8).
 *
 * This test reads the two Rust files at test time, regex-extracts each
 * limit, and asserts byte-for-byte equality against TS LOOP_LIMITS. If
 * anyone changes a default in one place without updating the others, this
 * fails CI before the drift can land. Mechanical, not philosophical —
 * either all three move together or the test fails.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const LOOP_ENGINE_RS = resolve(REPO_ROOT, 'crates/memphis-core/src/loop_engine.rs');
const CHAT_RS = resolve(REPO_ROOT, 'crates/memphis-operator/src/chat.rs');

function readFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function extractLoopEngineDefaults(): {
  max_steps: number;
  max_tool_calls: number;
  max_wait_ms: number;
  max_errors: number;
} {
  const content = readFile(LOOP_ENGINE_RS);
  const block = content.match(/impl Default for LoopLimits \{[\s\S]*?Self \{([\s\S]*?)\}\s*\}\s*\}/);
  if (!block) throw new Error('Could not locate LoopLimits::default block in loop_engine.rs');
  const body = block[1];
  function num(field: string): number {
    const m = body.match(new RegExp(`${field}\\s*:\\s*([0-9_]+)`));
    if (!m) throw new Error(`Field ${field} not found in LoopLimits::default`);
    return Number(m[1].replace(/_/g, ''));
  }
  return {
    max_steps: num('max_steps'),
    max_tool_calls: num('max_tool_calls'),
    max_wait_ms: num('max_wait_ms'),
    max_errors: num('max_errors'),
  };
}

function extractChatRsConstants(): {
  CHAT_MAX_STEPS_DEFAULT: number;
  CHAT_MAX_TOOL_CALLS_DEFAULT: number;
  CHAT_MAX_ERRORS_DEFAULT: number;
} {
  const content = readFile(CHAT_RS);
  function num(name: string): number {
    const m = content.match(new RegExp(`${name}\\s*:\\s*usize\\s*=\\s*([0-9_]+)`));
    if (!m) throw new Error(`Const ${name} not found in chat.rs`);
    return Number(m[1].replace(/_/g, ''));
  }
  return {
    CHAT_MAX_STEPS_DEFAULT: num('CHAT_MAX_STEPS_DEFAULT'),
    CHAT_MAX_TOOL_CALLS_DEFAULT: num('CHAT_MAX_TOOL_CALLS_DEFAULT'),
    CHAT_MAX_ERRORS_DEFAULT: num('CHAT_MAX_ERRORS_DEFAULT'),
  };
}

describe('loop-limits parity: TS LOOP_LIMITS ≡ Rust LoopLimits::default ≡ chat.rs CHAT_MAX_*_DEFAULT', () => {
  it('TS LOOP_LIMITS.max_steps === Rust loop_engine.rs LoopLimits::default.max_steps', () => {
    const rust = extractLoopEngineDefaults();
    expect(LOOP_LIMITS.max_steps).toBe(rust.max_steps);
  });

  it('TS LOOP_LIMITS.max_tool_calls === Rust loop_engine.rs LoopLimits::default.max_tool_calls', () => {
    const rust = extractLoopEngineDefaults();
    expect(LOOP_LIMITS.max_tool_calls).toBe(rust.max_tool_calls);
  });

  it('TS LOOP_LIMITS.max_wait_ms === Rust loop_engine.rs LoopLimits::default.max_wait_ms', () => {
    const rust = extractLoopEngineDefaults();
    expect(LOOP_LIMITS.max_wait_ms).toBe(rust.max_wait_ms);
  });

  it('TS LOOP_LIMITS.max_errors === Rust loop_engine.rs LoopLimits::default.max_errors', () => {
    const rust = extractLoopEngineDefaults();
    expect(LOOP_LIMITS.max_errors).toBe(rust.max_errors);
  });

  it('chat.rs CHAT_MAX_STEPS_DEFAULT === TS LOOP_LIMITS.max_steps', () => {
    const chatRs = extractChatRsConstants();
    expect(chatRs.CHAT_MAX_STEPS_DEFAULT).toBe(LOOP_LIMITS.max_steps);
  });

  it('chat.rs CHAT_MAX_TOOL_CALLS_DEFAULT === TS LOOP_LIMITS.max_tool_calls', () => {
    const chatRs = extractChatRsConstants();
    expect(chatRs.CHAT_MAX_TOOL_CALLS_DEFAULT).toBe(LOOP_LIMITS.max_tool_calls);
  });

  it('chat.rs CHAT_MAX_ERRORS_DEFAULT === TS LOOP_LIMITS.max_errors', () => {
    const chatRs = extractChatRsConstants();
    expect(chatRs.CHAT_MAX_ERRORS_DEFAULT).toBe(LOOP_LIMITS.max_errors);
  });

  it('all three sources agree post Phase 1.5 bump', () => {
    const rust = extractLoopEngineDefaults();
    const chatRs = extractChatRsConstants();
    expect({
      ts: LOOP_LIMITS,
      rustEngine: rust,
      chatRs: {
        max_steps: chatRs.CHAT_MAX_STEPS_DEFAULT,
        max_tool_calls: chatRs.CHAT_MAX_TOOL_CALLS_DEFAULT,
        max_errors: chatRs.CHAT_MAX_ERRORS_DEFAULT,
      },
    }).toEqual({
      ts: { max_steps: 1000, max_tool_calls: 1024, max_wait_ms: 120_000, max_errors: 32 },
      rustEngine: { max_steps: 1000, max_tool_calls: 1024, max_wait_ms: 120_000, max_errors: 32 },
      chatRs: { max_steps: 1000, max_tool_calls: 1024, max_errors: 32 },
    });
  });
});
