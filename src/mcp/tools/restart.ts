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
 * engine.
 *
 * Codex P2 (Round 4): when no operator config exists (first-run state),
 * this previously left alreadyElevated=false and the engine then refused
 * with "not-elevated" — MCP has no session-minting flow so the engine
 * could never succeed on that path. Now the first-run branch explicitly
 * marks the call as pre-validated (no secret to leak in that state).
 *
 * Codex P2 (Round 4): validateOperatorPassphrase throws on the attempt
 * rate-limit. Wrap in try/catch so brute-force attempts surface as a
 * controlled refusal instead of an uncaught exception leaking internals.
 */
export async function runMemphisRestart(
  input: { reason?: string; actor_id?: string; passphrase?: string } = {},
): Promise<MemphisRestartOutput> {
  let alreadyElevated: boolean;
  let elevatedVia: string;
  if (loadOperatorConfig(process.env)) {
    if (!input.passphrase) {
      return {
        ok: false,
        reason: 'not-elevated',
        message:
          'restart refused — operator passphrase required. Pass `passphrase` in the MCP tool input.',
      };
    }
    try {
      if (!validateOperatorPassphrase(input.passphrase, process.env)) {
        return {
          ok: false,
          reason: 'not-elevated',
          message: 'restart refused — operator passphrase did not validate.',
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason: 'not-elevated',
        message: `restart refused — ${err instanceof Error ? err.message : 'passphrase check failed'}`,
      };
    }
    alreadyElevated = true;
    elevatedVia = 'mcp-passphrase-arg';
  } else {
    // First-run: no operator config yet. The engine's tier-3 session gate
    // would still refuse on MCP (no session-minting flow), so pre-validate.
    alreadyElevated = true;
    elevatedVia = 'mcp-first-run-no-config';
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
