import { requestRestart } from '../../runtime/self-restart.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

/**
 * `memphis restart` — operator-facing self-restart.
 *
 * Requires an active tier-3 session for the CLI surface (operator
 * elevates via `security.tier.elevate` from TUI or by running with the
 * passphrase available via `MEMPHIS_OPERATOR_PASSPHRASE` after a
 * sufficient elevation flow). The engine refuses cleanly when no
 * supervisor is detected unless `MEMPHIS_RESTART_ALLOW_SUICIDE=true`.
 *
 * The actual exit happens on the next event-loop tick, so the JSON
 * response makes it back to the operator before the process dies.
 */
export async function handleSelfRestartCommand(
  context: CliContext,
): Promise<boolean> {
  const { args } = context;
  if (args.command !== 'restart') return false;

  const reason =
    typeof args.target === 'string' && args.target.length > 0
      ? args.target
      : undefined;

  const outcome = await requestRestart({
    surface: 'cli',
    actorId: 'cli',
    reason,
  });

  if (!outcome.ok) {
    print({ mode: 'restart', ...outcome }, args.json);
    return true;
  }

  print(
    {
      mode: 'restart',
      ...outcome,
      summary: `restart scheduled via ${outcome.supervisor.kind ?? 'allow-suicide'}; drain window ${outcome.drainTimeoutMs}ms`,
    },
    args.json,
  );
  return true;
}
