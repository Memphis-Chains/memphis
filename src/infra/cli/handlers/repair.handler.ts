/**
 * `memphis repair runtime` — its own handler file on purpose.
 *
 * The auth audit (`src/infra/cli/handlers/auth.handler.ts`) derives the
 * set of commands that ENFORCE the operator gate by scanning handler
 * files for a `requireOperatorAuth(` call site, at file granularity. A
 * gate living in `system.handler.ts` would therefore mark every command
 * that file dispatches — `help`, `doctor`, `models`, `ascii` — as gated,
 * which is false for all of them.
 *
 * One command, one file: the audit's per-file rule then says exactly
 * what is true.
 */

import { repairRuntimeState } from '../../runtime/runtime-repair.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

const REPAIR_COMMANDS = ['repair'] as const;

export async function handleRepairCommand(context: CliContext): Promise<boolean> {
  if (context.args.subcommand !== 'runtime') {
    throw new Error(
      'repair currently supports only: memphis repair runtime [--force] [--dry-run] [--operator-passphrase <secret>] [--json]',
    );
  }

  // Rewriting chain history is a tier-2 operation: it changes a hash
  // chain that exists to make history tamper-evident. The repair asks
  // for the operator's consent ONLY when the scan has found a block the
  // native core cannot read.
  //
  // The passphrase is never stored: it is asked for once, in this
  // terminal, and lives only in the session cache.
  //
  // `--dry-run` answers the question the operator asks BEFORE consenting:
  // what exactly would this change? It writes nothing, so it asks for no
  // passphrase.
  const result = await repairRuntimeState({
    rawEnv: process.env,
    force: context.args.force,
    dryRun: context.args.dryRun,
    authorizeHistoryRewrite: async () => {
      const { requireOperatorAuth } = await import('../../auth/operator-gate.js');
      return requireOperatorAuth(undefined, process.env, context.args.operatorPassphrase);
    },
  });

  if (context.args.json) {
    print(result, true);
  } else {
    console.log(`runtime repair: ${result.status}`);
    console.log(`recommended action: ${result.recommendedAction}`);
    console.log(`applied: ${result.applied.length}`);
    for (const item of result.applied) console.log(`  - ${item}`);
    if (result.skipped.length > 0) {
      console.log(`skipped: ${result.skipped.length}`);
      for (const item of result.skipped) console.log(`  - ${item}`);
    }
    if (result.warnings.length > 0) {
      console.log(`warnings: ${result.warnings.length}`);
      for (const item of result.warnings) console.log(`  - ${item}`);
    }
  }
  process.exitCode = result.ok ? 0 : 1;
  return true;
}

export const repairCommandHandler: CommandHandler = {
  name: 'repair',
  commands: REPAIR_COMMANDS,
  canHandle(context: CliContext): boolean {
    return REPAIR_COMMANDS.includes(context.args.command as (typeof REPAIR_COMMANDS)[number]);
  },
  handle(context: CliContext): Promise<boolean> {
    return handleRepairCommand(context);
  },
};
