import type {
  SoulLoopAction,
  SoulLoopLimits,
  SoulLoopState,
  SoulLoopStepResult,
} from '../../infra/storage/rust-chain-adapter.js';
import { NapiChainAdapter } from '../../infra/storage/rust-chain-adapter.js';

export type MemphisLoopStepInput = {
  state: SoulLoopState;
  action: SoulLoopAction;
  limits?: SoulLoopLimits;
};

export type MemphisLoopStepOutput = SoulLoopStepResult;

let cachedAdapter: NapiChainAdapter | null = null;

function getAdapter(): NapiChainAdapter {
  if (!cachedAdapter) {
    cachedAdapter = new NapiChainAdapter(process.env);
  }
  return cachedAdapter;
}

/**
 * Enforce a loop step via the Rust LoopEngine (compiled, deterministic).
 * This is the authoritative enforcement layer — if Rust says "no", the loop halts.
 *
 * Falls back to a pure-TS implementation if the Rust bridge is unavailable.
 */
export function runMemphisLoopStep(input: MemphisLoopStepInput): MemphisLoopStepOutput {
  try {
    const adapter = getAdapter();
    return adapter.soulLoopStep(input.state, input.action, input.limits);
  } catch {
    // Fallback: pure-TS enforcement (mirrors Rust logic)
    return applyLoopStepTs(input.state, input.action, input.limits);
  }
}

/**
 * Pure-TS fallback that mirrors the Rust LoopEngine logic.
 * Used when RUST_CHAIN_ENABLED=false or the native bridge is unavailable.
 */
function applyLoopStepTs(
  state: SoulLoopState,
  action: SoulLoopAction,
  limits?: SoulLoopLimits,
): SoulLoopStepResult {
  const lim: SoulLoopLimits = limits ?? {
    max_steps: 32,
    max_tool_calls: 16,
    max_wait_ms: 120_000,
    max_errors: 4,
  };

  const s = { ...state };

  if (s.completed || s.halt_reason) {
    return { applied: false, reason: 'loop_already_halted', state: s };
  }

  s.steps += 1;
  if (s.steps > lim.max_steps) {
    s.halt_reason = 'max_steps_exceeded';
    return { applied: false, reason: 'max_steps_exceeded', state: s };
  }

  if (action.type === 'tool_call') {
    s.tool_calls += 1;
    if (s.tool_calls > lim.max_tool_calls) {
      s.halt_reason = 'max_tool_calls_exceeded';
      return { applied: false, reason: 'max_tool_calls_exceeded', state: s };
    }
  } else if (action.type === 'wait') {
    s.wait_ms += action.data.duration_ms;
    if (s.wait_ms > lim.max_wait_ms) {
      s.halt_reason = 'max_wait_exceeded';
      return { applied: false, reason: 'max_wait_exceeded', state: s };
    }
  } else if (action.type === 'error') {
    s.errors += 1;
    if (s.errors > lim.max_errors) {
      s.halt_reason = 'max_errors_exceeded';
      return { applied: false, reason: 'max_errors_exceeded', state: s };
    }
    if (!action.data.recoverable) {
      s.completed = true;
      s.halt_reason = 'non_recoverable_error';
    }
  } else if (action.type === 'complete') {
    s.completed = true;
  }

  return { applied: true, state: s };
}
