import { requireOperatorAuth } from '../../auth/operator-gate.js';
import { requestRestart } from '../../runtime/self-restart.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

/**
 * `memphis restart` — operator-facing self-restart.
 *
 * Tier gating: the CLI surface has no tier-3 session path, so the command
 * runs its own operator-passphrase gate (interactive prompt, or
 * `--operator-passphrase <pass>` for non-interactive use) before telling
 * the engine `alreadyElevated: true`. The engine still runs the supervisor
 * check and refuses cleanly when no supervisor is detected unless
 * `MEMPHIS_RESTART_ALLOW_SUICIDE=true`.
 *
 * The actual exit happens on the next event-loop tick, so the JSON
 * response makes it back to the operator before the process dies.
 */
export async function handleSelfRestartCommand(
  context: CliContext,
): Promise<boolean> {
  const { args } = context;
  if (args.command !== 'restart') return false;

  // Codex P2 (Round 2): positional[1] is subcommand (e.g. `memphis restart
  // deploy`); previous code read positional[2] (target) which required
  // `memphis restart . deploy` to land a reason. Accept subcommand OR
  // target OR --reason so all three invocation shapes work.
  const reason =
    (typeof args.subcommand === 'string' && args.subcommand.length > 0
      ? args.subcommand
      : typeof args.target === 'string' && args.target.length > 0
        ? args.target
        : undefined);

  // Codex P1 (Round 2): CLI never gets tier-3 sessions minted — the only
  // session-granting flows are Telegram `/tier 3 <pass>` and TUI
  // `security.tier.elevate`. Run the operator-passphrase gate locally and
  // pass `alreadyElevated` to the engine.
  const authorized = await requireOperatorAuth(
    undefined,
    process.env,
    args.operatorPassphrase,
  );
  if (!authorized) {
    print(
      {
        mode: 'restart',
        ok: false,
        reason: 'not-elevated',
        message:
          'restart refused — operator passphrase required. Pass via --operator-passphrase or enter at the prompt.',
      },
      args.json,
    );
    return true;
  }

  const outcome = await requestRestart({
    surface: 'cli',
    actorId: 'cli',
    reason,
    alreadyElevated: true,
    elevatedVia: 'cli-operator-passphrase',
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
