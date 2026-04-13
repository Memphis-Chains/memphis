import { requestRestart, type RestartOutcome } from '../../infra/runtime/self-restart.js';

export type MemphisRestartOutput = RestartOutcome;

/**
 * Request a self-restart of the Memphis agent. Requires an active
 * tier-3 session for the MCP caller. See docs/self-restart.md.
 */
export async function runMemphisRestart(
  input: { reason?: string; actor_id?: string } = {},
): Promise<MemphisRestartOutput> {
  return requestRestart({
    surface: 'cli', // MCP callers map to the CLI tier-3 gate by convention
    actorId: input.actor_id ?? 'mcp',
    reason: input.reason,
  });
}
