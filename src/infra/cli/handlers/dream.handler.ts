import { handleDreamCommand } from '../commands/dream.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

const DREAM_COMMANDS = ['dream'] as const;

export const dreamCommandHandler: CommandHandler = {
  name: 'dream',
  commands: DREAM_COMMANDS,
  canHandle(context: CliContext): boolean {
    return DREAM_COMMANDS.includes(context.args.command as (typeof DREAM_COMMANDS)[number]);
  },
  handle(context: CliContext): Promise<boolean> {
    return handleDreamCommand(context);
  },
};
