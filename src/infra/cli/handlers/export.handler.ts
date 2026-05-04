import { handleExportMv2Command } from '../commands/export-mv2.js';
import { handleExportTrajectoriesCommand } from '../commands/export-trajectories.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

/**
 * `memphis export [trajectories|--format=mv2]` handler.
 *
 * Two routes:
 *   - `export trajectories` → JSONL trajectory dump (Y1 Q1 N9).
 *   - `export --format=mv2` → single-file `.mv2` container (Y1 Q1 N12,
 *     Sprint G scaffold). Distinguished by `args.format === 'mv2'`
 *     rather than a subcommand so the CLI surface matches the Q1 plan
 *     (`memphis export --format=mv2 --output PATH --include CSV`).
 */
const EXPORT_COMMANDS = ['export'] as const;

export const exportCommandHandler: CommandHandler = {
  name: 'export',
  commands: EXPORT_COMMANDS,
  canHandle(context: CliContext): boolean {
    if (!EXPORT_COMMANDS.includes(context.args.command as (typeof EXPORT_COMMANDS)[number])) {
      return false;
    }
    return context.args.subcommand === 'trajectories' || context.args.format === 'mv2';
  },
  async handle(context: CliContext): Promise<boolean> {
    if (context.args.subcommand === 'trajectories') {
      return handleExportTrajectoriesCommand(context);
    }
    if (context.args.format === 'mv2') {
      return handleExportMv2Command(context);
    }
    return false;
  },
};
