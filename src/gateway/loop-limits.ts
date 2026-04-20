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

export const LOOP_LIMITS: Readonly<LoopLimits> = Object.freeze({
  max_steps: 32,
  max_tool_calls: 64,
  max_wait_ms: 120_000,
  max_errors: 4,
});

export function formatLoopLimitsLine(): string {
  return `max_steps=${LOOP_LIMITS.max_steps}, max_tool_calls=${LOOP_LIMITS.max_tool_calls}, max_wait_ms=${LOOP_LIMITS.max_wait_ms}, max_errors=${LOOP_LIMITS.max_errors}`;
}
