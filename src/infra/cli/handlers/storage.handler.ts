import type { CliContext } from '../context.js';
import { handleStorageCommand } from '../commands/storage.js';
import type { CommandHandler } from './command-handler.js';

const STORAGE_COMMANDS = new Set(['chain', 'onboarding', 'trade']);

export const storageCommandHandler: CommandHandler = {
  name: 'storage',
  canHandle(context: CliContext): boolean {
    return STORAGE_COMMANDS.has(context.args.command ?? '');
  },
  handle(context: CliContext): Promise<boolean> {
    return handleStorageCommand(context);
  },
};
