/**
 * Auth adapters that return FailClosedResult.
 *
 * Wraps existing auth functions (requireOperatorAuth) so they integrate
 * with the fail-closed policy system in fail-closed.ts.
 */

import type { FailClosedResult } from './fail-closed.js';
import { allow, failClosed } from './fail-closed.js';
import { requireOperatorAuth } from '../infra/auth/operator-gate.js';

/**
 * Wraps requireOperatorAuth() with fail-closed semantics.
 */
export async function authOperatorFailClosed(
  env: NodeJS.ProcessEnv,
  passphrase?: string,
): Promise<FailClosedResult> {
  const authorized = await requireOperatorAuth(undefined, env, passphrase);
  if (authorized) return allow('operator authorized');
  return failClosed('Operator authentication required. Run: memphis operator login');
}
