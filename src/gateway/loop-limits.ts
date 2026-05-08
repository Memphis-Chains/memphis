/**
 * Canonical LOOP_LIMITS values for the Memphis agent runtime.
 *
 * Two places used to define these independently:
 *   - src/gateway/agent-runtime.ts had max_tool_calls=64 (bumped for complex tasks)
 *   - src/gateway/system-prompt.ts told the model max_tool_calls=16 in a
 *     hardcoded string and max_tool_calls=16 in a numeric constant used
 *     elsewhere
 *
 * Result: the runtime accepted tool calls the system prompt had told the
 * model were forbidden — a quiet policy drift that bit operator trust.
 *
 * This module is the single source of truth. If you need to change a
 * limit, change it here; every consumer interpolates from these values.
 *
 * Mirrors crates/memphis-core/src/loop_engine.rs LoopLimits defaults.
 * The Rust engine remains authoritative at runtime — these are the
 * TypeScript-side defaults used when no per-session override is set.
 */

import type { LoopLimits } from './chat-types.js';

// Phase 1.5 P4 follow-up (autopilot 2026-05-08): defaults bumped per
// LIMITS-MATRIX-2026-05-08 to align with Rust enforcement and remove
// silent caps. Operator constraint is "cost-unconstrained" — limits are
// safety nets, not budgets. Memphis must be able to work 2 weeks on a
// single question without artificial cutoff.
//
// The previous values:
//   - max_steps=48: ~15 tool rounds before halt; too tight for deep work
//   - max_tool_calls=64: TS said 64 but Rust enforced 16 — a silent gap
//     that bit operator trust during code-spelunking sessions
//   - max_errors=4: too aggressive for noisy/transient tool failures
//
// New values mirror Rust LoopLimits::default() in
// crates/memphis-core/src/loop_engine.rs and the CHAT_MAX_* constants
// in crates/memphis-operator/src/chat.rs. The parity test in
// tests/unit/loop-limits-parity.test.ts fails CI if any of the three
// surfaces drift again.
//
// Override via env at runtime (MEMPHIS_CHAT_MAX_STEPS, MEMPHIS_CHAT_MAX_TOOL_CALLS,
// MEMPHIS_CHAT_MAX_ERRORS) when a surface or test needs different bounds.
export const LOOP_LIMITS: Readonly<LoopLimits> = Object.freeze({
  max_steps: 1_000,
  max_tool_calls: 1_024,
  max_wait_ms: 120_000,
  max_errors: 32,
});

export function formatLoopLimitsLine(): string {
  return `max_steps=${LOOP_LIMITS.max_steps}, max_tool_calls=${LOOP_LIMITS.max_tool_calls}, max_wait_ms=${LOOP_LIMITS.max_wait_ms}, max_errors=${LOOP_LIMITS.max_errors}`;
}
