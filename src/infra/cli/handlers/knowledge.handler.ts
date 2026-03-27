import { handleKnowledgeCommand } from '../commands/knowledge.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

const KNOWLEDGE_COMMANDS = ['knowledge'] as const;

export const knowledgeCommandHandler: CommandHandler = {
  name: 'knowledge',
  commands: KNOWLEDGE_COMMANDS,
  canHandle(context: CliContext): boolean {
    return KNOWLEDGE_COMMANDS.includes(context.args.command as (typeof KNOWLEDGE_COMMANDS)[number]);
  },
  handle(context: CliContext): Promise<boolean> {
    return handleKnowledgeCommand(context);
  },
};
