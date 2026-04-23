import { handleExportTrajectoriesCommand } from '../commands/export-trajectories.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

/**
 * `memphis export [trajectories|...]` handler. Currently routes only
 * `export trajectories` (Y1 Q1 N9 PR C). Future `export --format=mv2`
 * (Y1 Q1 N12) will add another subcommand branch here.
 */
const EXPORT_COMMANDS = ['export'] as const;

export const exportCommandHandler: CommandHandler = {
  name: 'export',
  commands: EXPORT_COMMANDS,
  canHandle(context: CliContext): boolean {
    if (!EXPORT_COMMANDS.includes(context.args.command as (typeof EXPORT_COMMANDS)[number])) {
      return false;
    }
    // Only claim when we have a subcommand we know how to handle.
    return context.args.subcommand === 'trajectories';
  },
  async handle(context: CliContext): Promise<boolean> {
    if (context.args.subcommand === 'trajectories') {
      return handleExportTrajectoriesCommand(context);
    }
    return false;
  },
};
