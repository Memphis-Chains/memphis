import { handleProviderCommand } from '../commands/provider.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

export const providerCommandHandler: CommandHandler = {
  name: 'provider',
  commands: ['provider'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'provider';
  },
  async handle(context: CliContext): Promise<boolean> {
    return handleProviderCommand(context);
  },
};
