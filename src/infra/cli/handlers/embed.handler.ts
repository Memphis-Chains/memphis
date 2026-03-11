import type { CliContext } from '../context.js';
import { handleStorageCommand } from '../commands/storage.js';
import type { CommandHandler } from './command-handler.js';

export const embedCommandHandler: CommandHandler = {
  name: 'embed',
  canHandle(context: CliContext): boolean {
    return context.args.command === 'embed';
  },
  handle(context: CliContext): Promise<boolean> {
    return handleStorageCommand(context);
  },
};
