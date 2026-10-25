import { loadOperatorConfig } from '../auth/operator-gate.js';

/** Reads only configuration; never runs a KDF or returns verifier material. */
export function hasOperatorRecovery(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const config = loadOperatorConfig(rawEnv);
  return Boolean(config?.recoveryHash?.trim() && config?.recoveryQuestionHint?.trim());
}
