import type { CliContext } from '../context.js';
import { handleDebugCommand } from '../commands/debug.js';
import type { CommandHandler } from './command-handler.js';

export const debugCommandHandler: CommandHandler = {
  name: 'debug',
  commands: ['debug'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'debug';
  },
  handle(context: CliContext): Promise<boolean> {
    return handleDebugCommand(context);
  },
};
