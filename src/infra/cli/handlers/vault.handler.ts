import type { CliContext } from '../context.js';
import { handleStorageCommand } from '../commands/storage.js';
import type { CommandHandler } from './command-handler.js';

export const vaultCommandHandler: CommandHandler = {
  name: 'vault',
  canHandle(context: CliContext): boolean {
    return context.args.command === 'vault';
  },
  handle(context: CliContext): Promise<boolean> {
    return handleStorageCommand(context);
  },
};
