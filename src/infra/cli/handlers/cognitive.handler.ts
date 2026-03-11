import type { CliContext } from '../context.js';
import { handleCognitiveCommand } from '../commands/cognitive.js';
import type { CommandHandler } from './command-handler.js';

const COGNITIVE_COMMANDS = new Set(['reflect', 'tui']);

export const cognitiveCommandHandler: CommandHandler = {
  name: 'cognitive',
  canHandle(context: CliContext): boolean {
    return COGNITIVE_COMMANDS.has(context.args.command ?? '');
  },
  handle(context: CliContext): Promise<boolean> {
    return handleCognitiveCommand(context);
  },
};
