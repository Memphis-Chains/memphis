import type { CliContext } from '../context.js';
import { handleCognitiveCommand } from '../commands/cognitive.js';
import type { CommandHandler } from './command-handler.js';

const COGNITIVE_COMMANDS = [
  'reflect',
  'learn',
  'insights',
  'connections',
  'suggest',
  'categorize',
] as const;

export const cognitiveCommandHandler: CommandHandler = {
  name: 'cognitive',
  commands: COGNITIVE_COMMANDS,
  canHandle(context: CliContext): boolean {
    return COGNITIVE_COMMANDS.includes(
      context.args.command as (typeof COGNITIVE_COMMANDS)[number],
    );
  },
  handle(context: CliContext): Promise<boolean> {
    return handleCognitiveCommand(context);
  },
};
