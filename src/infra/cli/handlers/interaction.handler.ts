import type { CliContext } from '../context.js';
import { handleInteractionCommand } from '../commands/interaction.js';
import type { CommandHandler } from './command-handler.js';

const INTERACTION_COMMANDS = ['ask', 'chat', 'ask-session', 'providers:health', 'tui'] as const;

export const interactionCommandHandler: CommandHandler = {
  name: 'interaction',
  commands: INTERACTION_COMMANDS,
  canHandle(context: CliContext): boolean {
    return INTERACTION_COMMANDS.includes(
      context.args.command as (typeof INTERACTION_COMMANDS)[number],
    );
  },
  handle(context: CliContext): Promise<boolean> {
    return handleInteractionCommand(context);
  },
};
