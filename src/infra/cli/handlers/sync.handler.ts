import type { CliContext } from '../context.js';
import { handleSyncCommand } from '../commands/sync.js';
import type { CommandHandler } from './command-handler.js';

const SYNC_COMMANDS = new Set(['sync', 'network']);

export const syncCommandHandler: CommandHandler = {
  name: 'sync',
  canHandle(context: CliContext): boolean {
    return SYNC_COMMANDS.has(context.args.command ?? '');
  },
  handle(context: CliContext): Promise<boolean> {
    return handleSyncCommand(context);
  },
};
