import type { CliContext } from '../context.js';
import { handleDecisionCommand } from '../commands/decision.js';
import type { CommandHandler } from './command-handler.js';

const DECISION_COMMANDS = [
  'infer',
  'decide',
  'predict',
  'git-stats',
  'agents',
  'relationships',
  'trust',
] as const;

export const decisionCommandHandler: CommandHandler = {
  name: 'decision',
  commands: DECISION_COMMANDS,
  canHandle(context: CliContext): boolean {
    return DECISION_COMMANDS.includes(
      context.args.command as (typeof DECISION_COMMANDS)[number],
    );
  },
  handle(context: CliContext): Promise<boolean> {
    return handleDecisionCommand(context);
  },
};
