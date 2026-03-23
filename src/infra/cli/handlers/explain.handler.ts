import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

export const explainCommandHandler: CommandHandler = {
  name: 'explain',
  commands: ['explain'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'explain';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { handleExplainCommand } = await import('../commands/explain.js');
    return handleExplainCommand(context);
  },
};
