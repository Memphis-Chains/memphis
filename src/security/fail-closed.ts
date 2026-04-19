/**
 * Fail-closed policy enforcement.
 *
 * MemphisOS defaults to deny-on-failure: any auth/error condition
 * that is not explicitly allowed results in denial. This prevents
 * implicit permission grants due to misconfiguration.
 */

/**
 * Fail-closed result type.
 * - ok: true means the operation is allowed
 * - ok: false means the operation is denied (fail-closed)
 * - reason: explains why access was denied or granted
 */
export interface FailClosedResult {
  ok: boolean;
  reason: string;
}

/**
 * Policy decision types.
 */
export type PolicyDecision = 'allow' | 'deny' | 'require-approval' | 'error';

/**
 * Default fail-closed result for error conditions.
 */
export function failClosed(error: string): FailClosedResult {
  return { ok: false, reason: `fail-closed: ${error}` };
}

/**
 * Allow result for successful auth.
 */
export function allow(reason = 'authorized'): FailClosedResult {
  return { ok: true, reason };
}

/**
 * Deny result for explicit denial.
 */
export function deny(reason: string): FailClosedResult {
  return { ok: false, reason };
}

/**
 * Require approval result (not allowed, not denied - pending human decision).
 */
export function requireApproval(reason: string): FailClosedResult {
  return { ok: false, reason: `requires approval: ${reason}` };
}

/**
 * Evaluates a PolicyDecision under fail-closed semantics.
 *
 * @param decision - The raw policy decision
 * @param fallbackReason - Human-readable reason for the decision
 * @returns FailClosedResult with ok=true only if decision === 'allow'
 */
export function evaluateFailClosed(
  decision: PolicyDecision,
  fallbackReason: string,
): FailClosedResult {
  switch (decision) {
    case 'allow':
      return allow(fallbackReason);
    case 'deny':
      return deny(fallbackReason);
    case 'require-approval':
      return requireApproval(fallbackReason);
    case 'error':
    default:
      return failClosed(`error evaluating policy: ${fallbackReason}`);
  }
}

/**
 * Combines multiple fail-closed results with AND semantics.
 * All must be ok=true for the combined result to be ok=true.
 * Errors are propagated with combined reasons.
 */
export function combineResults(results: FailClosedResult[]): FailClosedResult {
  const reasons: string[] = [];

  for (const result of results) {
    if (!result.ok) {
      reasons.push(result.reason);
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reason: reasons.join('; ') };
  }

  return { ok: true, reason: 'all checks passed' };
}
