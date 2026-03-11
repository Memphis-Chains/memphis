import type { CliContext } from '../context.js';
import { handleSyncCommand } from '../commands/sync.js';
import type { CommandHandler } from './command-handler.js';

const SYNC_COMMANDS = ['sync', 'network'] as const;

export const syncCommandHandler: CommandHandler = {
  name: 'sync',
  commands: SYNC_COMMANDS,
  canHandle(context: CliContext): boolean {
    return SYNC_COMMANDS.includes(context.args.command as (typeof SYNC_COMMANDS)[number]);
  },
  handle(context: CliContext): Promise<boolean> {
    return handleSyncCommand(context);
  },
};
