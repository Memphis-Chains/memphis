import type { CliContext } from '../context.js';
import { handleSystemCommand } from '../commands/system.js';
import type { CommandHandler } from './command-handler.js';

export const systemCommandHandler: CommandHandler = {
  name: 'system',
  canHandle(_context: CliContext): boolean {
    return true;
  },
  handle(context: CliContext): Promise<boolean> {
    return handleSystemCommand(context);
  },
};
