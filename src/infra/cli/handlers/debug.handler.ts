import type { CliContext } from '../context.js';
import { handleDebugCommand } from '../commands/debug.js';
import type { CommandHandler } from './command-handler.js';

export const debugCommandHandler: CommandHandler = {
  name: 'debug',
  canHandle(_context: CliContext): boolean {
    return true;
  },
  handle(context: CliContext): Promise<boolean> {
    return handleDebugCommand(context);
  },
};
