import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Transport-owned identity, never derived from model/tool arguments. Grants
 * are process-local and expire on restart, logout or their TTL. */
export interface OperatorAuthContext { surface: string; subject: string; sessionId: string }
const contexts = new AsyncLocalStorage<OperatorAuthContext>();
const localContext: OperatorAuthContext = Object.freeze({ surface: 'cli', subject: 'local-operator', sessionId: randomUUID() });
export const currentOperatorContext = (): OperatorAuthContext => contexts.getStore() ?? localContext;
export function withOperatorContext<T>(context: OperatorAuthContext, run: () => T): T {
  if (!context.surface || !context.subject || !context.sessionId) throw new Error('Missing operator request context');
  return contexts.run(Object.freeze({ ...context }), run);
}
export function operatorContextKey(context = currentOperatorContext()): string {
  return JSON.stringify([context.surface, context.subject, context.sessionId]);
}
