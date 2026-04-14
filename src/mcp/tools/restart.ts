import {
  loadOperatorConfig,
  validateOperatorPassphrase,
} from '../../infra/auth/operator-gate.js';
import { requestRestart, type RestartOutcome } from '../../infra/runtime/self-restart.js';

export type MemphisRestartOutput = RestartOutcome;

/**
 * Request a self-restart of the Memphis agent.
 *
 * Codex P1 (Round 2): MCP has no tier-3 session flow — no `/tier 3 <pass>`
 * equivalent exists. The caller must include the operator `passphrase` in
 * the tool input; we validate here and pass `alreadyElevated: true` to the
 * engine. If no operator config is set yet (first-run state), the
 * passphrase requirement is relaxed.
 */
export async function runMemphisRestart(
  input: { reason?: string; actor_id?: string; passphrase?: string } = {},
): Promise<MemphisRestartOutput> {
  let alreadyElevated = false;
  let elevatedVia: string | undefined;
  if (loadOperatorConfig(process.env)) {
    if (!input.passphrase) {
      return {
        ok: false,
        reason: 'not-elevated',
        message:
          'restart refused — operator passphrase required. Pass `passphrase` in the MCP tool input.',
      };
    }
    if (!validateOperatorPassphrase(input.passphrase, process.env)) {
      return {
        ok: false,
        reason: 'not-elevated',
        message: 'restart refused — operator passphrase did not validate.',
      };
    }
    alreadyElevated = true;
    elevatedVia = 'mcp-passphrase-arg';
  }

  return requestRestart({
    // MCP is a distinct surface; tier-3 surface types accept 'cli' so we
    // map there (MCP is a CLI-adjacent headless caller).
    surface: 'cli',
    actorId: input.actor_id ?? 'mcp',
    reason: input.reason,
    alreadyElevated,
    elevatedVia,
  });
}
