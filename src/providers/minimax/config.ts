/** Stable MiniMax defaults; explicit operator model selections remain authoritative. */
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M3.1-Flash';

export const MINIMAX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type MinimaxReasoningEffort = (typeof MINIMAX_REASONING_EFFORTS)[number];

// The API defaults to max. Memphis uses an explicit, configurable balanced budget.
export const DEFAULT_MINIMAX_REASONING_EFFORT: MinimaxReasoningEffort = 'medium';
export const DEFAULT_MINIMAX_MAX_COMPLETION_TOKENS = 32_768;
export const MAX_MINIMAX_COMPLETION_TOKENS = 524_288;

export function resolveMinimaxReasoningEffort(value: unknown): MinimaxReasoningEffort {
  if (value === undefined) return DEFAULT_MINIMAX_REASONING_EFFORT;
  if (
    typeof value === 'string' &&
    MINIMAX_REASONING_EFFORTS.includes(value as MinimaxReasoningEffort)
  ) {
    return value as MinimaxReasoningEffort;
  }
  throw new Error('MiniMax reasoning effort must be low, medium, high, xhigh, or max');
}
