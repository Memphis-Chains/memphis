import type { CliContext } from '../context.js';
import { handleInteractionCommand } from '../commands/interaction.js';
import type { CommandHandler } from './command-handler.js';

const INTERACTION_COMMANDS = new Set(['ask', 'chat', 'health', 'providers:health']);

export const interactionCommandHandler: CommandHandler = {
  name: 'interaction',
  canHandle(context: CliContext): boolean {
    return INTERACTION_COMMANDS.has(context.args.command ?? '');
  },
  handle(context: CliContext): Promise<boolean> {
    return handleInteractionCommand(context);
  },
};
