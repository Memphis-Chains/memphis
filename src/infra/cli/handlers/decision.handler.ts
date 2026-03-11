import type { CliContext } from '../context.js';
import { handleDecisionCommand } from '../commands/decision.js';
import type { CommandHandler } from './command-handler.js';

const DECISION_COMMANDS = new Set(['infer', 'decide', 'predict', 'git-stats', 'agents', 'relationships', 'trust']);

export const decisionCommandHandler: CommandHandler = {
  name: 'decision',
  canHandle(context: CliContext): boolean {
    return DECISION_COMMANDS.has(context.args.command ?? '');
  },
  handle(context: CliContext): Promise<boolean> {
    return handleDecisionCommand(context);
  },
};
